'use strict';

/**
 * Smart View Distribution Engine — isolated plug-in entry point.
 *
 * The ONLY symbol server.js imports. Wiring rules:
 *   - Never throws into server boot (fully wrapped).
 *   - Flag-gated at runtime: when AppSettings.viewEngineEnabled is false (default)
 *     the engine stays dormant and behaves exactly as today.
 *   - PM2 cluster safe: the actual scheduler runs only on the elected leader.
 *
 * PHASE 2 scope: flag watcher + leader election + ticker wiring (ticker is a
 * no-op stub). No distribution/business logic runs yet.
 */

const config = require('./config');
const leader = require('./leader');
const ticker = require('./ticker');
const { LOG_PREFIX } = require('./constants');

const SUPERVISE_MS = 15000; // how often we reconcile desired (flag) vs actual (running)

let _supervisor = null;
let _running = false; // is the engine (leader election) currently active?

function startEngine(io) {
  if (_running) return;
  _running = true;
  leader.start({
    onGain: () => ticker.start(io), // only the leader ticks
    onLose: () => ticker.stop()
  });
}

async function stopEngine() {
  if (!_running) return;
  _running = false;
  ticker.stop();
  await leader.stop();
}

function superviseOnce(io) {
  const enabled = config.isEnabledCached();
  if (enabled && !_running) {
    console.log(`${LOG_PREFIX} flag ON → activating engine`);
    startEngine(io);
  } else if (!enabled && _running) {
    console.log(`${LOG_PREFIX} flag OFF → deactivating engine`);
    stopEngine();
  }
}

/**
 * Called once per process from server.js. Idempotent and crash-isolated.
 * @param {object} io - existing Socket.io server instance (used in Phase 3 for progress events).
 */
function maybeStartViewEngine(io) {
  if (maybeStartViewEngine._started) return;
  maybeStartViewEngine._started = true;
  try {
    config.startFlagWatcher();
    // Prime once, then reconcile flag → engine state on an interval (runtime toggle).
    superviseOnce(io);
    _supervisor = setInterval(() => superviseOnce(io), SUPERVISE_MS);
    if (_supervisor.unref) _supervisor.unref();
    console.log(
      `${LOG_PREFIX} initialized (flag-gated; currently ${config.isEnabledCached() ? 'ON' : 'OFF'})`
    );
  } catch (err) {
    // Never let the engine break server startup.
    console.error(`${LOG_PREFIX} init failed — engine disabled:`, err.message);
  }
}

module.exports = {
  maybeStartViewEngine,
  // exported for tests / graceful shutdown
  _stopEngine: stopEngine
};
