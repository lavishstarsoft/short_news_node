'use strict';

/**
 * TEHELKA NEXA — Central AI Orchestrator (public entrypoint).
 *
 * Safe to require anywhere: requiring this file has NO side effects and starts
 * nothing. Call init() once at server boot. When NEXA is disabled (default) or
 * the kill switch is on, init() logs and returns — the existing dashboard is
 * completely unaffected. If NEXA is ever disabled, the app keeps working.
 */

const { config, NEXA_NAME } = require('./config');
const autonomy = require('./autonomy');
const registry = require('./tools/registry');
const { registerReadTools } = require('./tools/readTools');
const queue = require('./queue');

let _initialized = false;

function init() {
  if (_initialized) return getStatus();
  _initialized = true;

  if (!config.isActive()) {
    console.log(`[NEXA] ${NEXA_NAME} disabled (NEXA_ENABLED=false or kill switch). Dashboard runs normally.`);
    return getStatus();
  }

  // Register the Phase-1 read-only tools (idempotent-guarded by the registry).
  try {
    registerReadTools();
  } catch (err) {
    console.warn('[NEXA] tool registration issue:', err && err.message);
  }

  console.log(
    `[NEXA] ${NEXA_NAME} active — shadow=${config.shadowMode()} maxAutonomy=L${config.maxAutonomy()} ` +
      `queue=${queue._probe() ? 'bullmq' : 'unavailable'}`,
  );

  // Bounded background triage drain — analyses EVERY eligible pending item over
  // time (not just the first batch). Gated by NEXA_TRIAGE_AUTO (default OFF);
  // shadow-only, never touches production news/status. Failure is non-fatal.
  try {
    require('./workflows/triageProcessor').startAutoProcessor();
  } catch (err) {
    console.warn('[NEXA] triage auto-processor start issue:', err && err.message);
  }

  return getStatus();
}

function getStatus() {
  return {
    name: NEXA_NAME,
    initialized: _initialized,
    enabled: config.enabled(),
    killSwitch: config.killSwitch(),
    active: config.isActive(),
    shadowMode: config.shadowMode(),
    maxAutonomy: config.maxAutonomy(),
    queueAvailable: config.isActive() ? queue._probe() : false,
    tools: registry.list(),
  };
}

module.exports = {
  NEXA_NAME,
  init,
  getStatus,
  config,
  autonomy,
  tools: registry, // run(), list(), register()
  queue,
};
