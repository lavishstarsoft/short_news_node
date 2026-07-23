'use strict';

/**
 * Phase-4.3 — Embedding pipeline health summary (ops only).
 * Does not change duplicate / gateway / advisory behavior.
 */

const { isAiEmbedWorkerEnabled } = require('./flags');
const { createEmbedWorkerMetrics } = require('./embedWorkerMetrics');
const { createNewsVectorQueueMetrics } = require('./newsVectorQueueMetrics');
const { loadAiConfig } = require('../config');
const { createHealthClient } = require('../health');
const embedPendingWorker = require('./embedPendingWorker');

function createEmbedPipelineHealth(deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  const metrics =
    deps.metrics ||
    (embedPendingWorker.maybeStartEmbedPendingWorker._worker &&
      embedPendingWorker.maybeStartEmbedPendingWorker._worker.metrics) ||
    createEmbedWorkerMetrics({ now });
  const queueMetrics =
    deps.queueMetrics ||
    createNewsVectorQueueMetrics({
      NewsVector: deps.NewsVector,
      now,
    });

  async function checkAiConnectivity() {
    if (typeof deps.checkAi === 'function') {
      return deps.checkAi();
    }

    const cfg = loadAiConfig(env);
    if (!cfg.baseUrl || !cfg.apiKey) {
      return {
        ok: false,
        reachable: false,
        reason: 'embed_config_missing',
      };
    }

    try {
      const client = createHealthClient({
        http: deps.http,
        getConfig: () => ({
          ...cfg,
          enabled: true,
          readyTimeoutMs: cfg.readyTimeoutMs || 2000,
          timeoutMs: cfg.timeoutMs || 2000,
        }),
        log: deps.log || { debug() {}, warn() {} },
      });
      const ready = await client.pingReady({ force: true });
      return {
        ok: ready.ok === true,
        reachable: ready.ok === true,
        status: ready.status || null,
        reason: ready.ok ? 'ready' : ready.error || ready.reason || 'unreachable',
      };
    } catch (err) {
      return {
        ok: false,
        reachable: false,
        reason: err && err.message ? err.message : 'ai_check_failed',
      };
    }
  }

  /**
   * Full ops snapshot — never throws.
   */
  async function getHealthReport() {
    const workerEnabled = isAiEmbedWorkerEnabled(env);
    const workerRunning = Boolean(
      embedPendingWorker.maybeStartEmbedPendingWorker._timer
    );

    let queue = {
      pending: null,
      ready: null,
      failed: null,
      stale: null,
      queueDepth: null,
      oldestPendingAgeMs: null,
      error: null,
    };
    try {
      queue = await queueMetrics.snapshot();
    } catch (err) {
      queue.error = err && err.message ? err.message : 'queue_failed';
    }

    let ai = { ok: false, reachable: false, reason: 'unchecked' };
    try {
      ai = await checkAiConnectivity();
    } catch (err) {
      ai = {
        ok: false,
        reachable: false,
        reason: err && err.message ? err.message : 'ai_failed',
      };
    }

    const worker = metrics.snapshot();

    return {
      phase: '4.3',
      collectedAt: new Date(now()).toISOString(),
      worker: {
        enabled: workerEnabled,
        running: workerRunning,
        metrics: worker,
      },
      queue: {
        pending: queue.pending,
        ready: queue.ready,
        failed: queue.failed,
        stale: queue.stale,
        queueDepth: queue.queueDepth,
        oldestPendingAgeMs: queue.oldestPendingAgeMs,
        oldestPendingAt: queue.oldestPendingAt,
        error: queue.error || null,
      },
      ai: {
        connectivity: ai.reachable === true ? 'up' : 'down',
        ok: ai.ok === true,
        reason: ai.reason || null,
        status: ai.status || null,
      },
      recentErrorCounts: {
        failures: worker.failure,
        retries: worker.retry,
        lastErrorCode: worker.lastErrorCode,
        recentErrors: worker.recentErrors || [],
      },
      summary: {
        healthy:
          (workerEnabled === false || workerRunning === true) &&
          queue.error == null,
        workerEnabled,
        queueDepth: queue.queueDepth,
        aiConnectivity: ai.reachable === true ? 'up' : 'down',
        recentFailures: worker.failure,
      },
    };
  }

  return {
    getHealthReport,
    checkAiConnectivity,
  };
}

module.exports = {
  createEmbedPipelineHealth,
};
