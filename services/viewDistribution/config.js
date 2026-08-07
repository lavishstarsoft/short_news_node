'use strict';

/**
 * config.js — single source of truth for the engine ON/OFF state.
 *
 * Requirements honoured:
 *  - Controlled by ONE AppSettings flag (viewEngineEnabled).
 *  - OFF (default) => engine dormant, consumer responses identical to today.
 *  - The display helper needs a SYNCHRONOUS answer per request, so we keep a
 *    cached boolean refreshed on a cheap timer. Until the first successful read
 *    the cache defaults to FALSE (fail-safe / backward compatible).
 *  - An env kill switch (VIEW_ENGINE_KILL=true) force-disables everything.
 */

const AppSettings = require('../../models/AppSettings');
const { FLAG_REFRESH_MS, KILL_ENV, LOG_PREFIX } = require('./constants');

let _enabledCache = false;   // fail-safe default: behaves exactly as today
let _lastLoadedAt = 0;
let _refreshTimer = null;

/** Env-level hard kill switch — overrides the DB flag. */
function isKilled() {
  return String(process.env[KILL_ENV] || '').toLowerCase() === 'true';
}

/**
 * Synchronous, cached ON/OFF for hot paths (the display serializer).
 * Never touches the DB; returns the last known value (default false).
 */
function isEnabledCached() {
  if (isKilled()) return false;
  return _enabledCache === true;
}

/** Authoritative async read (refreshes the cache). Used by the control loop. */
async function refreshEnabled() {
  if (isKilled()) {
    _enabledCache = false;
    _lastLoadedAt = Date.now();
    return false;
  }
  try {
    const settings = await AppSettings.findOne({ key: 'update_flags' })
      .select('viewEngineEnabled')
      .lean();
    _enabledCache = !!(settings && settings.viewEngineEnabled === true);
  } catch (err) {
    // On any error, fail safe to disabled — never let the engine misfire.
    _enabledCache = false;
    console.error(`${LOG_PREFIX} flag refresh failed, defaulting OFF:`, err.message);
  }
  _lastLoadedAt = Date.now();
  return _enabledCache;
}

/**
 * Start the lightweight background refresher (one indexed findOne / interval).
 * Idempotent — safe to call once per process from maybeStartViewEngine().
 */
function startFlagWatcher() {
  if (_refreshTimer) return;
  // Prime immediately, then poll.
  refreshEnabled();
  _refreshTimer = setInterval(refreshEnabled, FLAG_REFRESH_MS);
  if (_refreshTimer.unref) _refreshTimer.unref();
}

function stopFlagWatcher() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

module.exports = {
  isEnabledCached,
  refreshEnabled,
  startFlagWatcher,
  stopFlagWatcher,
  _debug: () => ({ enabled: _enabledCache, lastLoadedAt: _lastLoadedAt, killed: isKilled() })
};
