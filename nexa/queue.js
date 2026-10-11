'use strict';

/**
 * TEHELKA NEXA — durable job queue wrapper (BullMQ on the existing Redis).
 *
 * SAFETY: bullmq/ioredis are LAZY-required only when NEXA is active. If NEXA is
 * disabled OR the packages are not installed, this module is a graceful no-op —
 * the existing app is completely unaffected. Old fire-and-forget jobs keep
 * running until each queue is verified and cut over behind a flag.
 */

const { config } = require('./config');

let _available = null; // null=unknown, true/false once probed
let _connection = null;
const _queues = new Map();
const _workers = [];

function _probe() {
  if (_available !== null) return _available;
  try {
    require.resolve('bullmq');
    require.resolve('ioredis');
    _available = true;
  } catch {
    _available = false;
    console.warn('[NEXA][queue] bullmq/ioredis not installed — queue disabled (no-op).');
  }
  return _available;
}

function _conn() {
  if (_connection) return _connection;
  const IORedis = require('ioredis');
  _connection = new IORedis(config.redisConnection());
  return _connection;
}

/** Get (or lazily create) a durable queue. Returns null when NEXA is off/unavailable. */
function getQueue(name) {
  if (!config.isActive() || !_probe()) return null;
  if (_queues.has(name)) return _queues.get(name);
  const { Queue } = require('bullmq');
  const q = new Queue(`nexa:${name}`, {
    connection: _conn(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
  _queues.set(name, q);
  return q;
}

/** Register a worker for a queue with safe concurrency. No-op when NEXA is off. */
function registerWorker(name, processor, { concurrency = 3 } = {}) {
  if (!config.isActive() || !_probe()) return null;
  const { Worker } = require('bullmq');
  const worker = new Worker(`nexa:${name}`, processor, {
    connection: _conn(),
    concurrency,
  });
  worker.on('failed', (job, err) =>
    console.warn(`[NEXA][queue:${name}] job ${job && job.id} failed:`, err && err.message),
  );
  _workers.push(worker);
  return worker;
}

/** Enqueue a job. Returns null (and does nothing) when NEXA is off/unavailable. */
async function enqueue(name, jobName, data, opts) {
  const q = getQueue(name);
  if (!q) return null;
  return q.add(jobName, data, opts);
}

/** Lightweight counts for the Command Center. Safe when off. */
async function counts(name) {
  const q = getQueue(name);
  if (!q) return null;
  try {
    return await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
  } catch {
    return null;
  }
}

/** Graceful shutdown for SIGTERM handlers. */
async function shutdown() {
  await Promise.allSettled(_workers.map((w) => w.close()));
  await Promise.allSettled([..._queues.values()].map((q) => q.close()));
  if (_connection) {
    try {
      _connection.disconnect();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { getQueue, registerWorker, enqueue, counts, shutdown, _probe };
