'use strict';

/**
 * leader.js — Redis-based leader election for PM2 cluster safety.
 *
 * ecosystem.config.js runs `instances: 'max'` (cluster mode), so a naive
 * setInterval ticker would fire in every process. This elects exactly ONE
 * active instance cluster-wide to run the scheduler tick.
 *
 * Mechanism: SET vde:leader <instanceId> NX PX <ttl>. The holder renews on an
 * interval (atomic compare-and-extend via Lua). If the holder dies, the key
 * expires and another instance acquires it => restart-safe / failure-safe.
 *
 * Reuses the existing redisClient from config/redis.js. If Redis is unavailable
 * the instance is simply never leader (engine stays dormant — fail safe).
 */

const crypto = require('crypto');
const { redisClient, isRedisAvailable } = require('../../config/redis');
const { LEADER_KEY, LEADER_TTL_MS, LEADER_RENEW_MS, LOG_PREFIX } = require('./constants');

// Unique per process (PM2 instance id if present, else pid + random).
const INSTANCE_ID = [
  process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? 'x',
  process.pid,
  crypto.randomBytes(4).toString('hex')
].join('-');

// Atomically extend the TTL only if we still own the key.
const RENEW_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
// Atomically release only if we own it.
const RELEASE_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

let _timer = null;
let _isLeader = false;
let _onGain = null;
let _onLose = null;

function instanceId() {
  return INSTANCE_ID;
}

function isLeader() {
  return _isLeader === true;
}

async function tryAcquireOrRenew() {
  if (!isRedisAvailable()) {
    if (_isLeader) setLeader(false);
    return;
  }
  try {
    if (_isLeader) {
      // Renew; if we somehow lost ownership, drop leadership.
      const ok = await redisClient.eval(RENEW_LUA, {
        keys: [LEADER_KEY],
        arguments: [INSTANCE_ID, String(LEADER_TTL_MS)]
      });
      if (!ok) setLeader(false);
      return;
    }
    // Attempt to acquire.
    const res = await redisClient.set(LEADER_KEY, INSTANCE_ID, {
      NX: true,
      PX: LEADER_TTL_MS
    });
    if (res === 'OK') setLeader(true);
  } catch (err) {
    console.error(`${LOG_PREFIX} leader tick error:`, err.message);
    if (_isLeader) setLeader(false);
  }
}

function setLeader(next) {
  if (next === _isLeader) return;
  _isLeader = next;
  console.log(`${LOG_PREFIX} instance ${INSTANCE_ID} ${next ? 'ACQUIRED' : 'RELEASED'} leadership`);
  try {
    if (next && typeof _onGain === 'function') _onGain();
    if (!next && typeof _onLose === 'function') _onLose();
  } catch (err) {
    console.error(`${LOG_PREFIX} leadership callback error:`, err.message);
  }
}

/**
 * Begin participating in leader election. Idempotent.
 * @param {object} [handlers] { onGain, onLose } lifecycle callbacks.
 */
function start(handlers = {}) {
  _onGain = handlers.onGain || null;
  _onLose = handlers.onLose || null;
  if (_timer) return;
  tryAcquireOrRenew();
  _timer = setInterval(tryAcquireOrRenew, LEADER_RENEW_MS);
  if (_timer.unref) _timer.unref();
}

/** Stop electing and best-effort release the lock if held. */
async function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  if (_isLeader && isRedisAvailable()) {
    try {
      await redisClient.eval(RELEASE_LUA, { keys: [LEADER_KEY], arguments: [INSTANCE_ID] });
    } catch (_) {
      /* lock will expire on its own */
    }
  }
  _isLeader = false;
}

module.exports = { start, stop, isLeader, instanceId };
