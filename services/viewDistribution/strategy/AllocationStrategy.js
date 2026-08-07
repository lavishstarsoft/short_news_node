'use strict';

/**
 * AllocationStrategy.js — the pluggable scoring contract (Strategy pattern).
 *
 * ROLE (Single Responsibility): turn a set of normalized FeatureVectors into a
 * set of RELATIVE, non-negative weights — one per item. That is the ONLY job.
 *   - It does NOT enforce budget caps, cooldown, diversity, curve shaping, or
 *     idempotency. Those belong to the Allocator (File 5). Keeping scoring pure
 *     and safeguard-free is what makes strategies swappable and testable.
 *   - It does NOT read the DB, Redis, or time-of-day state beyond the immutable
 *     `context` it is handed. Strategies are PURE and STATELESS => cluster-safe
 *     (PM2), idempotent, and trivially unit-testable.
 *
 * WHY an abstract base + registry (not TypeScript interfaces):
 *   The codebase is plain CommonJS. The "interface" is expressed as an abstract
 *   class whose contract method throws until overridden, plus a factory registry
 *   so a campaign's `strategy` string ('adaptive' | 'ml' | ...) resolves to an
 *   implementation. New strategies register themselves — Open/Closed: no existing
 *   file changes when a future MlStrategy is added.
 *
 * ML-READY:
 *   An MlStrategy implements `decide()` by running a model over the SAME
 *   FeatureVector.features and emitting weights in the SAME envelope. `version`
 *   and `meta` carry the model id, so every ViewCycleLog.decisionSnapshot is a
 *   labelled training row (pairs with later ORGANIC lift).
 *
 * INPUT  FeatureVector  (from signalProvider.computeFeatureVectors):
 *   { itemId, organicNow, bucket:{category,region,publisher},
 *     features:{ freshness, engagement, velocity, scopeWeight,
 *                categoryWeight, breaking, priority } }
 *
 * CONTEXT (immutable, read-only):
 *   { campaign, cycleIndex, now }  // campaign carries intensity/strategy/etc.
 *
 * OUTPUT AllocationDecision:
 *   { strategy, version, generatedAt, decisions:[{itemId, weight>=0}], meta }
 */

const { LOG_PREFIX } = require('../constants');

class AllocationStrategy {
  /**
   * @param {object} [options] strategy-specific config (immutable after construction).
   */
  constructor(options = {}) {
    if (new.target === AllocationStrategy) {
      throw new Error('AllocationStrategy is abstract and cannot be instantiated directly');
    }
    // Freeze options so a strategy instance can never carry mutable shared state.
    this.options = Object.freeze({ ...(options || {}) });
  }

  /** Unique strategy id used in ViewCampaign.strategy and audit logs. Must override. */
  get name() {
    throw new Error('AllocationStrategy subclasses must override get name()');
  }

  /** Semver of the scoring logic — captured in every decision for auditability/training. */
  get version() {
    return '1.0.0';
  }

  /**
   * CONTRACT METHOD — subclasses implement.
   * MUST be pure: same (featureVectors, context) => same decision. No IO, no
   * mutation of inputs.
   *
   * @param {Array<object>} featureVectors
   * @param {object} context
   * @returns {AllocationDecision}
   */
  // eslint-disable-next-line no-unused-vars
  decide(featureVectors, context) {
    throw new Error(`Strategy "${this.name}" must implement decide(featureVectors, context)`);
  }

  // ---- shared helpers (available to every subclass) ----------------------

  /**
   * Validate the feature-vector array once, cheaply. Throwing here gives every
   * strategy a consistent guarantee about its inputs.
   */
  static assertFeatureVectors(featureVectors) {
    if (!Array.isArray(featureVectors)) {
      throw new TypeError('featureVectors must be an array');
    }
    for (const fv of featureVectors) {
      if (!fv || typeof fv.itemId === 'undefined' || typeof fv.features !== 'object') {
        throw new TypeError('each FeatureVector must have { itemId, features }');
      }
    }
    return true;
  }

  /**
   * Wrap raw {itemId, weight} rows into the canonical, SAFE decision envelope.
   * Sanitizes weights (non-finite/negative => 0) so the Allocator can fully trust
   * the output. This is the single place output shape is enforced.
   */
  buildDecision(rows, meta = {}, now = new Date()) {
    const decisions = [];
    for (const row of rows || []) {
      if (!row || typeof row.itemId === 'undefined') continue;
      const w = Number(row.weight);
      decisions.push({ itemId: String(row.itemId), weight: Number.isFinite(w) && w > 0 ? w : 0 });
    }
    return {
      strategy: this.name,
      version: this.version,
      generatedAt: now instanceof Date ? now : new Date(),
      decisions,
      meta: meta && typeof meta === 'object' ? meta : {}
    };
  }
}

// ------------------------------------------------------------------------
// Strategy registry — the extensibility seam (factory pattern).
// ------------------------------------------------------------------------

/** @type {Map<string, (options?:object)=>AllocationStrategy>} */
const _registry = new Map();

/**
 * Register a strategy factory under a stable name.
 * @param {string} name
 * @param {(options?:object)=>AllocationStrategy} factory
 */
function registerStrategy(name, factory) {
  if (!name || typeof factory !== 'function') {
    throw new Error('registerStrategy(name, factory) requires a name and a factory function');
  }
  if (_registry.has(name)) {
    // Overwriting is allowed (e.g. hot-swapping an ML version) but surfaced.
    console.warn(`${LOG_PREFIX} strategy "${name}" is being re-registered`);
  }
  _registry.set(name, factory);
}

/**
 * Resolve a strategy instance by name. Throws on unknown name so a mis-configured
 * campaign fails LOUD and is skipped by the caller — never silently mis-allocates.
 * @returns {AllocationStrategy}
 */
function resolveStrategy(name, options = {}) {
  const factory = _registry.get(name);
  if (!factory) {
    throw new Error(`Unknown allocation strategy "${name}" (registered: ${[..._registry.keys()].join(', ') || 'none'})`);
  }
  const instance = factory(options);
  if (!(instance instanceof AllocationStrategy)) {
    throw new Error(`Strategy factory for "${name}" did not return an AllocationStrategy`);
  }
  return instance;
}

function hasStrategy(name) {
  return _registry.has(name);
}

function listStrategies() {
  return [..._registry.keys()];
}

module.exports = {
  AllocationStrategy,
  registerStrategy,
  resolveStrategy,
  hasStrategy,
  listStrategies
};
