'use strict';

/**
 * View-count write buffering.
 *
 * Views are the highest-volume write in the app (a single popular story gets
 * hundreds of hits). Previously every batch of views ran a Mongo write. Here we
 * accumulate per-news view increments in a Redis hash and flush them to Mongo in
 * ONE bulkWrite every 20s — coalescing thousands of hits into a handful of
 * writes (~90%+ fewer DB writes).
 *
 * Safety / correctness:
 *  - Touches ONLY the `views` counter (never likes/dislikes/comments), so it
 *    cannot affect the interaction fix.
 *  - Atomic drain via RENAME, so new views collected during a flush aren't lost.
 *  - Fails safe: if a bulkWrite errors the counts are put back in the buffer; if
 *    Redis is unavailable the caller falls back to a direct DB write, so view
 *    counting never breaks — it just isn't buffered.
 *  - Flushed on process shutdown; worst case a crash loses <20s of view deltas
 *    (an acceptable trade for social-proof counters).
 */

const { redisClient, isRedisAvailable } = require('../config/redis');
const News = require('../models/News');

const BUFFER_KEY = 'views:buffer';
const FLUSH_KEY = 'views:buffer:flush';
const FLUSH_INTERVAL_MS = 20000;
const MAX_OPS = 500; // chunk bulkWrite so a huge window can't build one giant op

let flushing = false;
let timer = null;

/**
 * Buffer +1 view for each id. Returns true if buffered in Redis, false if Redis
 * is unavailable (the caller should then write to Mongo directly).
 */
async function bufferViews(ids) {
  if (!isRedisAvailable() || !Array.isArray(ids) || ids.length === 0) return false;
  try {
    const multi = redisClient.multi();
    for (const id of ids) multi.hIncrBy(BUFFER_KEY, String(id), 1);
    await multi.exec();
    return true;
  } catch (e) {
    console.warn('viewBuffer.bufferViews failed (falling back to DB):', e.message);
    return false;
  }
}

async function _applyMap(map) {
  const entries = Object.entries(map || {})
    .map(([id, v]) => [id, Number(v)])
    .filter(([, v]) => Number.isFinite(v) && v > 0);
  if (entries.length === 0) return 0;

  let applied = 0;
  for (let i = 0; i < entries.length; i += MAX_OPS) {
    const chunk = entries.slice(i, i + MAX_OPS);
    const ops = chunk.map(([id, v]) => ({
      updateOne: {
        filter: { _id: id, isActive: { $ne: false } },
        update: { $inc: { views: v } },
      },
    }));
    try {
      const res = await News.bulkWrite(ops, { ordered: false });
      applied += res.modifiedCount || 0;
    } catch (e) {
      // Don't lose the counts — put this chunk back in the live buffer.
      console.error('viewBuffer bulkWrite failed, re-buffering chunk:', e.message);
      if (isRedisAvailable()) {
        try {
          const multi = redisClient.multi();
          for (const [id, v] of chunk) multi.hIncrBy(BUFFER_KEY, id, v);
          await multi.exec();
        } catch (_) { /* best effort */ }
      }
    }
  }
  return applied;
}

/** Drain the buffer atomically and flush to Mongo. Safe to call concurrently. */
async function flushViewBuffer() {
  if (flushing || !isRedisAvailable()) return;
  flushing = true;
  try {
    // Recover a leftover flush key from a previously crashed run first.
    if (await redisClient.exists(FLUSH_KEY)) {
      await _applyMap(await redisClient.hGetAll(FLUSH_KEY));
      await redisClient.del(FLUSH_KEY);
    }
    if (!(await redisClient.exists(BUFFER_KEY))) return;
    // Atomic swap: new views now accumulate in a fresh BUFFER_KEY.
    await redisClient.rename(BUFFER_KEY, FLUSH_KEY);
    await _applyMap(await redisClient.hGetAll(FLUSH_KEY));
    await redisClient.del(FLUSH_KEY);
  } catch (e) {
    console.error('viewBuffer.flush error:', e.message);
  } finally {
    flushing = false;
  }
}

/** Start the periodic flusher (idempotent). */
function startViewFlusher() {
  if (timer) return;
  timer = setInterval(() => { flushViewBuffer().catch(() => {}); }, FLUSH_INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log(`🧮 View-buffer flusher started (every ${FLUSH_INTERVAL_MS / 1000}s)`);
}

module.exports = { bufferViews, flushViewBuffer, startViewFlusher };
