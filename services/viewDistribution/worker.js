'use strict';

/**
 * worker.js — the cycle-job consumer loop. TRANSPORT ONLY (no business logic).
 *
 * Responsibilities:
 *   - Poll queue.consume() on an interval, hand each job to an injected `handler`.
 *   - ACK on success; on failure leave the job PENDING so queue.reclaim() retries
 *     it (and eventually dead-letters it) — the worker never inline-retries.
 *   - Periodically call queue.reclaim() to recover jobs from crashed workers.
 *   - Graceful shutdown that drains in-flight work.
 *
 * Design guarantees:
 *   - STATELESS (business-wise): holds only in-memory timers + metrics. All
 *     durable state lives in Redis/Mongo, so any instance can be killed anytime.
 *   - PM2-SAFE: many workers share one consumer group; the queue distributes jobs
 *     one-per-worker. This file assumes it is NOT the only consumer.
 *   - IDEMPOTENT: the injected handler must be idempotent (Applier's unique-index
 *     ledger guarantees it); a redelivered job is safe to process again.
 *   - RETRY-AWARE: failures are surfaced via metrics and left for reclaim/DLQ.
 *   - ERROR-ISOLATED: one job's throw never affects sibling jobs or the loop.
 *
 * The actual "process one cycle" logic (load campaign/state -> Strategy ->
 * Allocator -> Applier) is injected as `handler(job)` — kept OUT of this file.
 */

const crypto = require('crypto');
const defaultQueue = require('./queue');
const { LOG_PREFIX } = require('./constants');

const DEFAULTS = {
  pollIntervalMs: 1000,
  batchSize: 10,
  reclaimIntervalMs: 60000,
  minIdleMs: 60000,
  maxAttempts: 5,
  reclaimBatch: 50,
  shutdownGraceMs: 10000
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function freshMetrics() {
  return {
    startedAt: null,
    processed: 0,
    succeeded: 0,
    failed: 0,
    reclaimed: 0,
    loopErrors: 0,
    lastError: null,
    lastSuccessAt: null,
    lastRunAt: null
  };
}

// Module-level singleton state (one worker per process — matches PM2 model).
let _running = false;
let _busy = false;
let _inflight = 0;
let _pollTimer = null;
let _reclaimTimer = null;
let _cfg = null;
let _queue = defaultQueue;
let _handler = null;
let _consumerName = null;
let _metrics = freshMetrics();

function isRunning() {
  return _running;
}

function getMetrics() {
  return { ..._metrics, running: _running, inflight: _inflight, consumerName: _consumerName };
}

/** Process a single job with full error isolation. Never throws. */
async function processJob(job) {
  if (!job || !job.id) return;
  _inflight++;
  _metrics.processed++;
  _metrics.lastRunAt = Date.now();
  try {
    await _handler(job); // business logic lives here (injected)
    await _queue.ack(job.id);
    _metrics.succeeded++;
    _metrics.lastSuccessAt = Date.now();
  } catch (err) {
    // Do NOT ack => stays pending => reclaim retries => eventual DLQ.
    _metrics.failed++;
    _metrics.lastError = err && err.message ? err.message : String(err);
    console.error(
      `${LOG_PREFIX} worker: job ${job.id} (campaign ${job.campaignId} cycle ${job.cycleIndex}) failed: ${_metrics.lastError}`
    );
  } finally {
    _inflight--;
  }
}

/** Poll loop — self-scheduling to prevent overlapping runs. */
async function pollTick() {
  if (!_running) return;
  _busy = true;
  try {
    const jobs = await _queue.consume({ consumerName: _consumerName, count: _cfg.batchSize });
    for (const job of jobs) {
      if (!_running) break; // stop draining new jobs once shutting down
      await processJob(job);
    }
  } catch (err) {
    _metrics.loopErrors++;
    console.error(`${LOG_PREFIX} worker poll error:`, err && err.message);
  } finally {
    _busy = false;
    if (_running) {
      _pollTimer = setTimeout(pollTick, _cfg.pollIntervalMs);
      if (_pollTimer.unref) _pollTimer.unref();
    }
  }
}

/** Reclaim loop — recovers stale pending jobs from crashed workers. */
async function reclaimTick() {
  if (!_running) return;
  try {
    const jobs = await _queue.reclaim({
      consumerName: _consumerName,
      minIdleMs: _cfg.minIdleMs,
      maxAttempts: _cfg.maxAttempts,
      count: _cfg.reclaimBatch
    });
    if (jobs && jobs.length) {
      _metrics.reclaimed += jobs.length;
      console.log(`${LOG_PREFIX} worker reclaimed ${jobs.length} stale job(s)`);
      for (const job of jobs) {
        if (!_running) break;
        await processJob(job);
      }
    }
  } catch (err) {
    _metrics.loopErrors++;
    console.error(`${LOG_PREFIX} worker reclaim error:`, err && err.message);
  } finally {
    if (_running) {
      _reclaimTimer = setTimeout(reclaimTick, _cfg.reclaimIntervalMs);
      if (_reclaimTimer.unref) _reclaimTimer.unref();
    }
  }
}

/**
 * Start the worker. Idempotent.
 * @param {object} opts
 *   @param {(job)=>Promise} opts.handler       REQUIRED — processes one cycle job.
 *   @param {string} [opts.consumerName]        stable unique id (e.g. leader.instanceId()).
 *   @param {object} [opts.queue]               DI for tests; defaults to ./queue.
 *   @param {number} [opts.pollIntervalMs] etc. see DEFAULTS.
 */
function start(opts = {}) {
  if (_running) return true;
  if (typeof opts.handler !== 'function') {
    console.error(`${LOG_PREFIX} worker.start: handler function is required — not started`);
    return false;
  }
  _handler = opts.handler;
  _queue = opts.queue || defaultQueue;
  _consumerName = opts.consumerName || 'w-' + crypto.randomBytes(4).toString('hex');
  _cfg = { ...DEFAULTS, ...opts };
  _metrics = freshMetrics();
  _metrics.startedAt = Date.now();
  _running = true;

  pollTick();
  _reclaimTimer = setTimeout(reclaimTick, _cfg.reclaimIntervalMs);
  if (_reclaimTimer.unref) _reclaimTimer.unref();

  console.log(`${LOG_PREFIX} worker started (consumer ${_consumerName})`);
  return true;
}

/** Graceful shutdown: stop scheduling, drain in-flight work, then resolve. */
async function stop() {
  if (!_running) return;
  _running = false;
  if (_pollTimer) clearTimeout(_pollTimer);
  if (_reclaimTimer) clearTimeout(_reclaimTimer);
  _pollTimer = null;
  _reclaimTimer = null;

  const grace = (_cfg && _cfg.shutdownGraceMs) || DEFAULTS.shutdownGraceMs;
  const deadline = Date.now() + grace;
  while ((_busy || _inflight > 0) && Date.now() < deadline) {
    await sleep(50);
  }
  console.log(`${LOG_PREFIX} worker stopped (drained, inflight ${_inflight})`);
}

module.exports = {
  start,
  stop,
  isRunning,
  getMetrics,
  // exported for tests
  _processJob: processJob
};
