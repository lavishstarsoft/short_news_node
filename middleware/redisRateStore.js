'use strict';

/**
 * Distributed, cluster-shared rate-limit store.
 *
 * Backs express-rate-limit with Redis so counters are GLOBAL — shared across every
 * PM2 worker AND every machine (a MemoryStore only limits per-process, which is
 * useless at scale). Keyed by the real client IP (Cloudflare → X-Forwarded-For, with
 * `trust proxy` set), so one abusive IP is throttled everywhere at once.
 *
 * RESILIENCE — fails OPEN: if Redis is unavailable or a command errors, requests are
 * ALLOWED rather than 500'd, so a cache blip can never take the whole API down.
 * Cloudflare remains the frontline DDoS defense; this is the app-layer backstop.
 */

const { RedisStore } = require('rate-limit-redis');
const { redisClient, isRedisAvailable } = require('../config/redis');

function createRedisRateStore(prefix) {
  const inner = new RedisStore({
    prefix,
    // node-redis v4/v5: sendCommand takes an args array.
    sendCommand: (...args) => redisClient.sendCommand(args),
  });

  let windowMs = 15 * 60 * 1000; // overwritten by init()
  const allow = () => ({ totalHits: 1, resetTime: new Date(Date.now() + windowMs) });

  return {
    localKeys: false,
    init(options) {
      windowMs = (options && options.windowMs) || windowMs;
      if (typeof inner.init === 'function') inner.init(options);
    },
    async get(key) {
      if (!isRedisAvailable() || typeof inner.get !== 'function') return undefined;
      try { return await inner.get(key); } catch (_) { return undefined; }
    },
    async increment(key) {
      if (!isRedisAvailable()) return allow();          // Redis down → don't block
      try { return await inner.increment(key); }
      catch (_) { return allow(); }                     // command error → don't block
    },
    async decrement(key) {
      if (!isRedisAvailable()) return;
      try { await inner.decrement(key); } catch (_) { /* fail-open */ }
    },
    async resetKey(key) {
      if (!isRedisAvailable()) return;
      try { await inner.resetKey(key); } catch (_) { /* fail-open */ }
    },
    async resetAll() {
      if (!isRedisAvailable() || typeof inner.resetAll !== 'function') return;
      try { await inner.resetAll(); } catch (_) { /* fail-open */ }
    },
  };
}

module.exports = { createRedisRateStore };
