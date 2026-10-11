'use strict';

/**
 * TEHELKA NEXA — Autonomy gate.
 *
 * Decides whether NEXA may EXECUTE an action or must only SUGGEST / ask a human.
 * It is the single chokepoint that enforces:
 *   - global shadow mode  → never execute, only record
 *   - global max autonomy  → cap what any workflow may do
 *   - per-action autonomy level + confidence threshold
 *   - HARD-BLOCKED categories that ALWAYS require a human (never automatable)
 */

const { config } = require('./config');

const LEVELS = Object.freeze({
  L0: 0, // suggest only
  L1: 1, // low-risk automatic
  L2: 2, // automatic + audit
  L3: 3, // automatic if confidence high, else human review
  L4: 4, // multi-step autonomous (approved low-risk workflows)
  L5: 5, // extremely narrow, deterministic, low-risk only
});

/**
 * Actions that must ALWAYS go through a human, no matter the confidence or
 * autonomy level. NEXA can recommend, never execute these.
 */
const HUMAN_ONLY = Object.freeze([
  'publish_sensitive',
  'wallet_change',
  'earning_change',
  'tier_change',
  'reporter_restrict',
  'reporter_suspend',
  'hr_decision',
  'legal_decision',
]);

const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;

/**
 * @param {object} decision
 * @param {string} decision.action        logical action name
 * @param {number} decision.autonomyLevel required level for this action (L0..L5)
 * @param {number} [decision.confidence]  0..1
 * @param {string} [decision.category]    optional category for HUMAN_ONLY match
 * @param {number} [decision.threshold]   confidence needed for L3 auto
 * @returns {{execute:boolean, requiresApproval:boolean, mode:'shadow'|'live'|'blocked', reason:string}}
 */
function evaluate(decision = {}) {
  const {
    action = 'unknown',
    autonomyLevel = LEVELS.L0,
    confidence = 0,
    category = null,
    threshold = DEFAULT_CONFIDENCE_THRESHOLD,
  } = decision;

  // 1) Hard human-only categories — never executable.
  if (HUMAN_ONLY.includes(action) || (category && HUMAN_ONLY.includes(category))) {
    return { execute: false, requiresApproval: true, mode: 'blocked', reason: 'human_only_action' };
  }

  // 2) NEXA inactive (disabled / killed) → suggest only.
  if (!config.isActive()) {
    return { execute: false, requiresApproval: false, mode: 'blocked', reason: 'nexa_inactive' };
  }

  // 3) Global shadow mode → record, never execute.
  if (config.shadowMode()) {
    return { execute: false, requiresApproval: false, mode: 'shadow', reason: 'shadow_mode' };
  }

  // 4) Respect the global autonomy cap.
  if (autonomyLevel > config.maxAutonomy()) {
    return { execute: false, requiresApproval: true, mode: 'live', reason: 'above_max_autonomy' };
  }

  // 5) Level rules.
  if (autonomyLevel <= LEVELS.L0) {
    return { execute: false, requiresApproval: false, mode: 'live', reason: 'suggest_only' };
  }
  if (autonomyLevel === LEVELS.L3) {
    if (confidence >= threshold) {
      return { execute: true, requiresApproval: false, mode: 'live', reason: 'high_confidence' };
    }
    return { execute: false, requiresApproval: true, mode: 'live', reason: 'low_confidence_needs_human' };
  }
  // L1, L2, L4, L5 (already capped by maxAutonomy) → execute + audit.
  return { execute: true, requiresApproval: false, mode: 'live', reason: 'within_autonomy' };
}

module.exports = { LEVELS, HUMAN_ONLY, evaluate, DEFAULT_CONFIDENCE_THRESHOLD };
