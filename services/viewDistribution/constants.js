'use strict';

/**
 * Shared constants for the Smart View Distribution Engine.
 * Namespaced Redis keys keep the engine fully isolated from existing cache keys.
 */
module.exports = {
  // Redis key namespace (all engine keys start with this).
  REDIS_PREFIX: 'vde:',

  // Leader election.
  LEADER_KEY: 'vde:leader',
  LEADER_TTL_MS: 15000,        // lock lifetime; must exceed renew interval
  LEADER_RENEW_MS: 5000,       // how often the leader renews / others attempt acquire

  // How often each instance refreshes the cached ON/OFF flag from AppSettings.
  FLAG_REFRESH_MS: 30000,

  // Hard kill switch via env (belt-and-suspenders alongside the AppSettings flag).
  KILL_ENV: 'VIEW_ENGINE_KILL',

  // Log prefix, matching existing worker conventions (e.g. [ReferralCron]).
  LOG_PREFIX: '[ViewEngine]'
};
