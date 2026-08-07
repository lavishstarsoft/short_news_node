'use strict';

/**
 * AdaptiveStrategy.js — the default concrete AllocationStrategy ("adaptive").
 *
 * Turns normalized FeatureVectors into RELATIVE per-item weights using
 * intensity-derived coefficients, then shapes those weights to HONOR the three
 * safeguard inputs (budget, cooldown, diversity).
 *
 * IMPORTANT layering note (consistent with File 2):
 *   This is SOFT shaping at the scoring layer — it biases the distribution so
 *   safeguards are respected up front. The Allocator (File 5) remains the HARD
 *   authority that guarantees absolute caps, monotonicity, and per-cycle limits.
 *   Two layers = defense in depth; the strategy can never *exceed* a cap because
 *   the allocator clamps regardless.
 *
 * Guarantees:
 *   - PURE & STATELESS: output depends only on (featureVectors, context). No DB,
 *     Redis, clock, or mutation of inputs => PM2-safe, idempotent, testable.
 *   - Uses ONLY the existing FeatureVector shape from signalProvider.
 *   - ML-ready: scoring is isolated in _scoreItem(); a future MlStrategy swaps it
 *     out while reusing the same safeguard-shaping pipeline. Coefficients are also
 *     overridable via options.weights (tune without code change).
 */

const {
  AllocationStrategy,
  registerStrategy
} = require('./AllocationStrategy');

// Coefficient presets per intensity dial. Each set sums to 1.0 for readability
// (not required). Heuristics — documented as tunable and ML-replaceable.
const INTENSITY_WEIGHTS = {
  conservative: { freshness: 0.15, engagement: 0.40, velocity: 0.30, breaking: 0.05, priority: 0.10 },
  balanced:     { freshness: 0.25, engagement: 0.30, velocity: 0.25, breaking: 0.10, priority: 0.10 },
  aggressive:   { freshness: 0.35, engagement: 0.20, velocity: 0.25, breaking: 0.15, priority: 0.05 }
};
const DEFAULT_INTENSITY = 'balanced';

// ---- tiny pure helpers -------------------------------------------------
function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function posNum(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function sumWeights(items) {
  let s = 0;
  for (const it of items) s += it.weight;
  return s;
}
/** Read from a Map or a plain object, tolerating either shape (or undefined). */
function lookup(source, key) {
  if (!source) return undefined;
  if (typeof source.get === 'function') return source.get(key);
  return source[key];
}

class AdaptiveStrategy extends AllocationStrategy {
  get name() {
    return 'adaptive';
  }
  get version() {
    return '1.0.0';
  }

  /** Resolve the coefficient set: explicit options override > intensity preset. */
  _coefficients(campaign) {
    if (this.options.weights && typeof this.options.weights === 'object') {
      return this.options.weights;
    }
    const intensity = (campaign && campaign.intensity) || DEFAULT_INTENSITY;
    return INTENSITY_WEIGHTS[intensity] || INTENSITY_WEIGHTS[DEFAULT_INTENSITY];
  }

  /**
   * ML seam: the entire "features -> scalar" mapping lives here. Replace this in
   * a subclass/MlStrategy and the safeguard pipeline below is reused verbatim.
   */
  _scoreItem(features, coeff) {
    const f = features || {};
    const base =
      coeff.freshness * clamp01(f.freshness) +
      coeff.engagement * clamp01(f.engagement) +
      coeff.velocity * clamp01(f.velocity) +
      coeff.breaking * (f.breaking ? 1 : 0) +
      coeff.priority * clamp01(f.priority);
    // scope/category are gentle multiplicative importance factors (default 1.0).
    const mult = posNum(f.scopeWeight, 1) * posNum(f.categoryWeight, 1);
    return Math.max(0, base * mult);
  }

  /**
   * Diversity shaping (Safeguard #3, soft): for each configured dimension, scale
   * down items whose bucket exceeds maxBucketShare of the running total. Applied
   * per-dimension so no single category/region/publisher dominates visibility.
   */
  _applyDiversity(items, dims, maxBucketShare) {
    if (!(maxBucketShare > 0 && maxBucketShare < 1)) return 0;
    let damped = 0;
    for (const dim of dims) {
      const total = sumWeights(items);
      if (total <= 0) break;
      const bucketSum = Object.create(null);
      for (const it of items) {
        const b = (it.bucket && it.bucket[dim]) || 'unknown';
        bucketSum[b] = (bucketSum[b] || 0) + it.weight;
      }
      for (const it of items) {
        const b = (it.bucket && it.bucket[dim]) || 'unknown';
        const share = bucketSum[b] / total;
        if (share > maxBucketShare) {
          it.weight *= maxBucketShare / share;
          damped++;
        }
      }
    }
    return damped;
  }

  /**
   * Contract method. See AllocationStrategy for input/output shapes.
   */
  decide(featureVectors, context = {}) {
    AllocationStrategy.assertFeatureVectors(featureVectors);
    const campaign = context.campaign || {};
    const cycleIndex = Number.isFinite(context.cycleIndex) ? context.cycleIndex : 0;
    const coeff = this._coefficients(campaign);

    const cooldownCfg = campaign.cooldown || {};
    const budgetCfg = campaign.budgetProtection || {};
    const diversityCfg = campaign.diversity || {};

    // Safeguard input sources (supplied by the allocator from ViewDistributionState).
    const cooldownByItem = context.cooldownByItem; // itemId -> cooldownUntilCycle (number)
    const budgetByItem = context.budgetByItem;     // itemId -> { remaining }

    let cooldownSkipped = 0;
    let budgetSkipped = 0;

    // 1) base score + 2) honor cooldown & budget inputs (zero-out non-eligible).
    const items = featureVectors.map((fv) => {
      let weight = this._scoreItem(fv.features, coeff);

      // Cooldown (Safeguard #2): rest an item that was recently boosted.
      if (cooldownCfg.enabled !== false) {
        const until = lookup(cooldownByItem, fv.itemId);
        if (Number.isFinite(until) && until > cycleIndex) {
          weight = 0;
          cooldownSkipped++;
        }
      }

      // Budget (Safeguard #1): an item that already hit its cap gets no weight.
      const bud = lookup(budgetByItem, fv.itemId);
      if (bud && Number.isFinite(bud.remaining) && bud.remaining <= 0) {
        weight = 0;
        budgetSkipped++;
      }

      return { itemId: fv.itemId, weight, bucket: fv.bucket || {} };
    });

    // 3) Diversity shaping (Safeguard #3).
    const dims = Array.isArray(diversityCfg.dimensions) && diversityCfg.dimensions.length
      ? diversityCfg.dimensions
      : ['category', 'region', 'publisher'];
    const maxBucketShare =
      diversityCfg.enabled !== false && Number.isFinite(diversityCfg.maxBucketSharePct)
        ? diversityCfg.maxBucketSharePct / 100
        : 0;
    const diversityDamped = this._applyDiversity(items, dims, maxBucketShare);

    // 4) Per-item budget-share clamp (Safeguard #1, soft): no single item's weight
    //    may exceed maxItemSharePct of the (post-diversity) total. The allocator
    //    still enforces absolute caps — this just curbs domination early.
    let itemShareClamped = 0;
    const maxItemSharePct = Number(budgetCfg.maxItemSharePct);
    if (Number.isFinite(maxItemSharePct) && maxItemSharePct > 0 && maxItemSharePct < 100) {
      const total = sumWeights(items);
      if (total > 0) {
        const cap = (maxItemSharePct / 100) * total;
        for (const it of items) {
          if (it.weight > cap) {
            it.weight = cap;
            itemShareClamped++;
          }
        }
      }
    }

    // Diagnostics captured into ViewCycleLog.decisionSnapshot (audit + ML training).
    const meta = {
      intensity: campaign.intensity || DEFAULT_INTENSITY,
      coefficients: coeff,
      eligible: items.length,
      cooldownSkipped,
      budgetSkipped,
      diversityDamped,
      itemShareClamped
    };

    return this.buildDecision(
      items.map((it) => ({ itemId: it.itemId, weight: it.weight })),
      meta,
      context.now
    );
  }
}

// Self-register on import (Open/Closed). Importing this file makes 'adaptive'
// resolvable — pure in-memory, no DB/Redis side effects.
registerStrategy('adaptive', (options) => new AdaptiveStrategy(options));

module.exports = { AdaptiveStrategy, INTENSITY_WEIGHTS };
