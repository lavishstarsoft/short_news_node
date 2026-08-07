'use strict';

/**
 * queue.js — Redis Streams transport for cycle jobs (no DB, no business logic).
 *
 * Why Redis Streams + a consumer group:
 *   - AT-LEAST-ONCE: XREADGROUP delivers each entry to exactly one consumer and
 *     keeps it PENDING until XACK. A crash before ack => the entry is reclaimable.
 *   - RETRY + DLQ for free: Redis tracks per-entry deliveryCount; we reclaim stale
 *     pending entries (XCLAIM) and route entries past maxAttempts to a dead stream.
 *   - PM2 CLUSTER-SAFE: many consumers in one group => a job runs on one worker.
 *   - DEDUP: a SET NX marker on campaignId+cycleIndex stops the leader from
 *     enqueuing the same cycle twice. Combined with the ledger's unique index
 *     (Applier), processing is effectively exactly-once.
 *
 * Design notes:
 *   - Reuses the EXISTING shared redisClient. We therefore use NON-BLOCKING reads
 *     (no BLOCK) — a blocking command on the shared cache connection would stall
 *     other Redis users. The Worker (File 7) polls on an interval instead. If a
 *     dedicated connection is added later, BLOCK can be enabled here.
 *   - Every op guards isRedisAvailable() and never throws to the caller
 *     (fail-safe: returns empty/negative results so the engine degrades quietly).
 *   - Streams are trimmed (MAXLEN ~) and acked entries are XDEL'd => bounded memory
 *     even at millions of cycles (high performance).
 */

const crypto = require('crypto');
const { redisClient, isRedisAvailable } = require('../../config/redis');
const { REDIS_PREFIX, LOG_PREFIX } = require('./constants');

// ---- namespaced keys ----------------------------------------------------
const STREAM = REDIS_PREFIX + 'cycles';        // vde:cycles       (job stream)
const GROUP = REDIS_PREFIX + 'workers';        // vde:workers      (consumer group)
const DLQ = REDIS_PREFIX + 'cycles:dead';      // vde:cycles:dead  (dead-letter)
const ENQ_PREFIX = REDIS_PREFIX + 'enq:';      // vde:enq:{campaignId}:{cycleIndex}

// ---- defaults -----------------------------------------------------------
const ENQ_TTL_MS = 10 * 60 * 1000;   // dedup marker lifetime (> processing+retry window)
const MAX_STREAM_LEN = 100000;       // approximate trim ceiling
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MIN_IDLE_MS = 60 * 1000;
const DEFAULT_CLAIM_BATCH = 50;

// Fallback consumer id (unique per process) if the caller does not supply one.
const FALLBACK_CONSUMER = 'c-' + crypto.randomBytes(4).toString('hex');

let _groupReady = false;

/** Create the consumer group once (idempotent; MKSTREAM auto-creates the stream). */
async function ensureGroup() {
  if (_groupReady) return true;
  try {
    await redisClient.xGroupCreate(STREAM, GROUP, '0', { MKSTREAM: true });
  } catch (err) {
    if (!/BUSYGROUP/i.test(err.message)) {
      console.error(`${LOG_PREFIX} queue.ensureGroup error:`, err.message);
      return false;
    }
  }
  _groupReady = true;
  return true;
}

/** Parse a raw stream entry into a typed job (pure). */
function parseJob(entry) {
  if (!entry || !entry.id || !entry.message) return null;
  const m = entry.message;
  const cycleIndex = Number(m.cycleIndex);
  if (!m.campaignId || !Number.isFinite(cycleIndex)) return null;
  return {
    id: entry.id,
    campaignId: String(m.campaignId),
    cycleIndex,
    enqueuedAt: Number(m.enqueuedAt) || 0
  };
}

/**
 * Enqueue a cycle job, deduped by campaignId+cycleIndex.
 * @returns {Promise<{enqueued:boolean, id?:string, reason?:string}>}
 */
async function enqueue(campaignId, cycleIndex) {
  if (!isRedisAvailable()) return { enqueued: false, reason: 'redis_unavailable' };
  const dedupKey = ENQ_PREFIX + campaignId + ':' + cycleIndex;
  try {
    // Dedup gate: only the first enqueue of this (campaign, cycle) wins.
    const set = await redisClient.set(dedupKey, '1', { NX: true, PX: ENQ_TTL_MS });
    if (set !== 'OK') return { enqueued: false, reason: 'duplicate' };

    if (!(await ensureGroup())) return { enqueued: false, reason: 'group_unavailable' };

    const id = await redisClient.xAdd(
      STREAM,
      '*',
      { campaignId: String(campaignId), cycleIndex: String(cycleIndex), enqueuedAt: String(Date.now()) },
      { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: MAX_STREAM_LEN } }
    );
    return { enqueued: true, id };
  } catch (err) {
    console.error(`${LOG_PREFIX} queue.enqueue error:`, err.message);
    // Release the dedup marker so a later tick can retry this cycle.
    try { await redisClient.del(dedupKey); } catch (_) { /* ignore */ }
    return { enqueued: false, reason: 'error', error: err.message };
  }
}

/**
 * Read up to `count` new jobs for this consumer (non-blocking).
 * @returns {Promise<Array<{id,campaignId,cycleIndex,enqueuedAt}>>}
 */
async function consume({ consumerName = FALLBACK_CONSUMER, count = 10 } = {}) {
  if (!isRedisAvailable()) return [];
  if (!(await ensureGroup())) return [];
  try {
    const res = await redisClient.xReadGroup(
      GROUP,
      consumerName,
      [{ key: STREAM, id: '>' }],
      { COUNT: count }
    );
    if (!res || !res.length) return [];
    const stream = res.find((s) => s.name === STREAM) || res[0];
    return (stream.messages || []).map(parseJob).filter(Boolean);
  } catch (err) {
    console.error(`${LOG_PREFIX} queue.consume error:`, err.message);
    return [];
  }
}

/** Acknowledge + delete a fully-processed job (keeps the stream bounded). */
async function ack(id) {
  if (!isRedisAvailable() || !id) return false;
  try {
    await redisClient.xAck(STREAM, GROUP, id);
    await redisClient.xDel(STREAM, id);
    return true;
  } catch (err) {
    console.error(`${LOG_PREFIX} queue.ack error:`, err.message);
    return false;
  }
}

/**
 * Reclaim stale pending jobs for retry, and route exhausted ones to the DLQ.
 * Uses Redis-native deliveryCount => no custom attempt bookkeeping.
 * @returns {Promise<Array>} jobs re-assigned to this consumer for reprocessing.
 */
async function reclaim({
  consumerName = FALLBACK_CONSUMER,
  minIdleMs = DEFAULT_MIN_IDLE_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  count = DEFAULT_CLAIM_BATCH
} = {}) {
  if (!isRedisAvailable()) return [];
  if (!(await ensureGroup())) return [];
  const retried = [];
  try {
    const pending = await redisClient.xPendingRange(STREAM, GROUP, '-', '+', count);
    for (const p of pending || []) {
      if (p.millisecondsSinceLastDelivery < minIdleMs) continue;

      if (p.deliveryCount > maxAttempts) {
        // Dead-letter: preserve the payload, then remove from the live stream.
        try {
          const msgs = await redisClient.xRange(STREAM, p.id, p.id);
          const fields = (msgs && msgs[0] && msgs[0].message) || {};
          await redisClient.xAdd(DLQ, '*', {
            ...fields,
            origId: String(p.id),
            deadReason: 'max_attempts',
            deliveryCount: String(p.deliveryCount),
            deadAt: String(Date.now())
          });
          await redisClient.xAck(STREAM, GROUP, p.id);
          await redisClient.xDel(STREAM, p.id);
          console.warn(`${LOG_PREFIX} queue: job ${p.id} -> DLQ (attempts ${p.deliveryCount})`);
        } catch (err) {
          console.error(`${LOG_PREFIX} queue.reclaim DLQ error:`, err.message);
        }
        continue;
      }

      // Otherwise reassign to this consumer for another attempt.
      try {
        const claimed = await redisClient.xClaim(STREAM, GROUP, consumerName, minIdleMs, [p.id]);
        for (const c of claimed || []) {
          const j = parseJob(c);
          if (j) retried.push(j);
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} queue.reclaim claim error:`, err.message);
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} queue.reclaim error:`, err.message);
  }
  return retried;
}

/** Lightweight health snapshot for monitoring (File 11+). */
async function stats() {
  if (!isRedisAvailable()) return { available: false };
  try {
    const stream = await redisClient.xLen(STREAM).catch(() => 0);
    const dlq = await redisClient.xLen(DLQ).catch(() => 0);
    let pending = 0;
    try {
      const p = await redisClient.xPending(STREAM, GROUP);
      pending = (p && (p.pending ?? p.count)) || 0;
    } catch (_) { /* group may not exist yet */ }
    return { available: true, stream, pending, dlq };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

module.exports = {
  enqueue,
  consume,
  ack,
  reclaim,
  stats,
  ensureGroup,
  // exported for tests
  parseJob,
  KEYS: { STREAM, GROUP, DLQ, ENQ_PREFIX }
};
