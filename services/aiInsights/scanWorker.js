'use strict';

/**
 * Background poller for AI Insights duplicate scan.
 * Default OFF via AI_INSIGHTS_SCAN_ENABLED.
 * Never runs on HTTP page-load paths.
 */

const { isAiInsightsScanEnabled, loadInsightsConfig } = require('./flags');
const { createScanService } = require('./scanService');

function createInsightsScanWorker(deps = {}) {
  const getConfig = () => loadInsightsConfig(deps.env || process.env);
  const scanService =
    deps.scanService ||
    createScanService({
      env: deps.env || process.env,
      log: deps.log,
    });
  const log = deps.log || console;

  let lastFullScanAt = 0;
  let running = false;

  async function tick() {
    const config = getConfig();
    if (!config.scanEnabled) return { skipped: true, reason: 'disabled' };
    if (running) return { skipped: true, reason: 'in_flight' };

    const now = Date.now();
    if (now - lastFullScanAt < config.fullScanCooldownMs) {
      return { skipped: true, reason: 'cooldown' };
    }

    running = true;
    try {
      const result = await scanService.runFullScan({ trigger: 'schedule' });
      if (result.ok) lastFullScanAt = Date.now();
      return result;
    } finally {
      running = false;
    }
  }

  return {
    tick,
    _setLastFullScanAt(ts) {
      lastFullScanAt = ts;
    },
  };
}

function maybeStartInsightsScanWorker(deps = {}) {
  const env = deps.env || process.env;
  if (!isAiInsightsScanEnabled(env)) {
    return { started: false, reason: 'disabled' };
  }
  if (maybeStartInsightsScanWorker._timer) {
    return { started: true, reason: 'already_running' };
  }

  const config = loadInsightsConfig(env);
  const worker = createInsightsScanWorker({ env, log: deps.log });
  maybeStartInsightsScanWorker._worker = worker;

  // Delayed first tick so Mongo connection can settle
  const bootDelay = setTimeout(() => {
    worker.tick().catch((err) => {
      console.warn('[AI Insights] initial scan tick failed', err?.message || err);
    });
  }, 20000);

  const timer = setInterval(() => {
    worker.tick().catch((err) => {
      console.warn('[AI Insights] scan tick failed', err?.message || err);
    });
  }, config.scanPollMs);

  if (typeof timer.unref === 'function') timer.unref();
  if (typeof bootDelay.unref === 'function') bootDelay.unref();

  maybeStartInsightsScanWorker._timer = timer;
  maybeStartInsightsScanWorker._bootDelay = bootDelay;

  console.log(
    `[AI Insights] scan worker started (poll ${config.scanPollMs}ms, cooldown ${config.fullScanCooldownMs}ms)`
  );
  return { started: true, reason: 'started' };
}

function stopInsightsScanWorker() {
  if (maybeStartInsightsScanWorker._bootDelay) {
    clearTimeout(maybeStartInsightsScanWorker._bootDelay);
    maybeStartInsightsScanWorker._bootDelay = null;
  }
  if (maybeStartInsightsScanWorker._timer) {
    clearInterval(maybeStartInsightsScanWorker._timer);
    maybeStartInsightsScanWorker._timer = null;
  }
  maybeStartInsightsScanWorker._worker = null;
}

module.exports = {
  createInsightsScanWorker,
  maybeStartInsightsScanWorker,
  stopInsightsScanWorker,
};
