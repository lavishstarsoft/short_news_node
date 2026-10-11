'use strict';

/**
 * TEHELKA NEXA — Central AI Orchestrator: configuration & feature flags.
 *
 * EVERYTHING IS OFF BY DEFAULT. If NEXA is disabled (or the kill switch is on),
 * the existing dashboard behaves exactly as before — NEXA must never be a
 * dependency of any existing production request path.
 *
 * Env flags:
 *   NEXA_ENABLED=false        master switch (default OFF)
 *   NEXA_KILL_SWITCH=false    emergency stop (overrides everything)
 *   NEXA_SHADOW_MODE=true     decisions are RECORDED, not executed (default ON)
 *   NEXA_WF_<NAME>=false      per-workflow enable (default OFF)
 *   NEXA_MAX_AUTONOMY=1       highest autonomy level NEXA may use (default L1)
 */

function bool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  return v === 'true' || v === '1' || v === 'yes';
}
function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

const NEXA_NAME = 'TEHELKA NEXA';

const config = {
  name: NEXA_NAME,

  /** Master switch. */
  enabled() {
    return bool(process.env.NEXA_ENABLED, false);
  },
  /** Emergency stop — when true, NEXA does nothing regardless of other flags. */
  killSwitch() {
    return bool(process.env.NEXA_KILL_SWITCH, false);
  },
  /** Shadow mode: record "what I would do" but never execute. Default ON. */
  shadowMode() {
    return bool(process.env.NEXA_SHADOW_MODE, true);
  },
  /** Per-workflow enable, default OFF. */
  workflowEnabled(name) {
    return bool(process.env[`NEXA_WF_${String(name || '').toUpperCase()}`], false);
  },
  /** Highest autonomy level NEXA is permitted to use globally (default L1). */
  maxAutonomy() {
    return int(process.env.NEXA_MAX_AUTONOMY, 1);
  },

  /**
   * The single source of truth every NEXA entrypoint checks first.
   * enabled AND not killed. Shadow mode is handled separately by the gate.
   */
  isActive() {
    return this.enabled() && !this.killSwitch();
  },

  /** ioredis connection options built from the SAME env the app already uses. */
  redisConnection() {
    if (process.env.REDIS_HOST) {
      return {
        host: process.env.REDIS_HOST,
        port: int(process.env.REDIS_PORT, 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        // Required by BullMQ:
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      };
    }
    // URL mode (e.g. cloud). BullMQ accepts a connection URL via ioredis.
    return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  },
};

module.exports = { config, NEXA_NAME };
