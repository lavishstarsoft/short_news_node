'use strict';

const C = require('./constants');

/**
 * Feature flag loader — AI is OFF unless AI_DUPLICATE_ENABLED is explicitly true.
 * Does not read MongoDB / AppSettings in Phase-1 (env only).
 * Pure functions — no singleton, no network, no side effects.
 */
function loadFeatureFlag(env = process.env) {
  const raw = env[C.ENV_ENABLED];
  const enabled = raw === 'true' || raw === '1' || raw === 'yes';
  return {
    enabled,
    raw: raw === undefined ? null : String(raw),
    source: 'env',
    key: C.ENV_ENABLED,
  };
}

function isAiDuplicateEnabled(env = process.env) {
  return loadFeatureFlag(env).enabled;
}

module.exports = {
  loadFeatureFlag,
  isAiDuplicateEnabled,
};
