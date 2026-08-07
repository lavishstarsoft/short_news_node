'use strict';

/**
 * allocator.js — the HARD-enforcement authority of the engine.
 *
 * Two pure, deterministic responsibilities:
 *
 *   allocateTargets()   — run on (re)balance. Converts strategy weights into each
 *                         item's budget BAND [floor, cap], hard-enforcing:
 *                           • per-item budget cap (maxItemSharePct + perItemMaxViews)
 *                           • diversity (bucket share cap)
 *                           • monotonicity (cap can never drop below deliveredTotal)
 *
 *   computeCycleDeltas() — run every tick. Converts the curve F(t) + band into the
 *                          per-item synthetic delta for THIS cycle, hard-enforcing:
 *                           • monotonic growth (delta >= 0, never removes views)
 *                           • budget cap (delivered + delta <= cap)
 *                           • max-step smoothing (no sudden jumps)
 *                           • cooldown (rest N cycles after a boost)
 *
 * Guarantees:
 *   - PURE / DETERMINISTIC: output depends only on the arguments. No DB, Redis,
 *     wall-clock, or Math.random. Jitter is SEEDED by (itemId, cycleIndex), so the
 *     "randomized" increments are reproducible => IDEMPOTENT + RESTART-SAFE: recomputing
 *     the same cycle yields the exact same deltas, and PM2 workers agree.
 *   - Inputs are never mutated; new plain objects are returned.
 *
 * The Strategy handles SOFT shaping; the Allocator is the authority that can never
 * be exceeded — defense in depth.
 */

const curve = require('./curve');

// ---- tiny pure helpers -------------------------------------------------
function toInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}
function posNum(n, fallback) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Deterministic per-(item, cycle) jitter factor in [1-jp, 1+jp].
 * FNV-1a hash => reproducible "randomness" => idempotent deltas.
 */
function seededJitter(itemId, cycleIndex, jitterPct) {
  if (!(jitterPct > 0)) return 1;
  const str = String(itemId) + ':' + String(cycleIndex);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const u = (h >>> 0) / 0xffffffff; // [0,1)
  return 1 + (u * 2 - 1) * jitterPct; // [1-jp, 1+jp]
}

/**
 * Scale down items whose bucket share exceeds `maxBucketShare`, per dimension.
 * Mutates the local `targets` array (private to this call) — deterministic.
 */
function enforceDiversity(targets, dims, maxBucketShare) {
  if (!(maxBucketShare > 0 && maxBucketShare < 1)) return;
  for (const dim of dims) {
    let total = 0;
    for (const t of targets) total += t.cap;
    if (total <= 0) break;
    const bucketSum = Object.create(null);
    for (const t of targets) {
      const b = (t.bucket && t.bucket[dim]) || 'unknown';
      bucketSum[b] = (bucketSum[b] || 0) + t.cap;
    }
    for (const t of targets) {
      const b = (t.bucket && t.bucket[dim]) || 'unknown';
      const share = bucketSum[b] / total;
      if (share > maxBucketShare) t.cap *= maxBucketShare / share;
    }
  }
}

/**
 * (Re)compute each item's budget band from strategy weights.
 *
 * @param {object} params
 *   @param {object} params.decision  AllocationStrategy output { decisions:[{itemId,weight}] }
 *   @param {Array}  params.states    current per-item state [{itemId, deliveredTotal, bucket}]
 *   @param {object} params.campaign  { minViews, maxViews, budgetProtection, diversity }
 * @returns {Array<{itemId, score, cap, floor, bucket}>}
 */
function allocateTargets(params = {}) {
  const decision = params.decision || { decisions: [] };
  const states = Array.isArray(params.states) ? params.states : [];
  const campaign = params.campaign || {};

  const minViews = Math.max(0, toInt(campaign.minViews));
  const maxViews = Math.max(minViews, toInt(campaign.maxViews));
  const budgetCfg = campaign.budgetProtection || {};
  const diversityCfg = campaign.diversity || {};

  // Index weights + state by itemId.
  const weightById = new Map();
  for (const d of decision.decisions || []) {
    const w = Number(d.weight);
    weightById.set(String(d.itemId), Number.isFinite(w) && w > 0 ? w : 0);
  }
  const deliveredById = new Map();
  const bucketById = new Map();
  for (const s of states) {
    deliveredById.set(String(s.itemId), Math.max(0, toInt(s.deliveredTotal)));
    bucketById.set(String(s.itemId), s.bucket || {});
  }

  // Weight range over ACTIVE (positive-weight) items => map to [minViews, maxViews].
  let wMin = Infinity;
  let wMax = -Infinity;
  for (const [, w] of weightById) {
    if (w > 0) {
      if (w < wMin) wMin = w;
      if (w > wMax) wMax = w;
    }
  }
  const wRange = wMax - wMin;

  // 1) Raw target per item (higher weight => closer to maxViews; all distinct).
  const ids = new Set([...weightById.keys(), ...deliveredById.keys()]);
  const targets = [];
  for (const id of ids) {
    const w = weightById.get(id) || 0;
    let T = 0;
    if (w > 0) {
      const frac = wRange > 0 ? (w - wMin) / wRange : 1;
      T = minViews + (maxViews - minViews) * frac;
    }
    targets.push({ itemId: id, weight: w, cap: T, bucket: bucketById.get(id) || {} });
  }

  // 2) Budget protection (Safeguard #1) — absolute per-item ceilings.
  let totalT = 0;
  for (const t of targets) totalT += t.cap;
  const perItemMax = posNum(budgetCfg.perItemMaxViews, Infinity);
  const maxItemSharePct = Number(budgetCfg.maxItemSharePct);
  const shareCap =
    Number.isFinite(maxItemSharePct) && maxItemSharePct > 0 && maxItemSharePct < 100 && totalT > 0
      ? (maxItemSharePct / 100) * totalT
      : Infinity;
  for (const t of targets) t.cap = Math.min(t.cap, perItemMax, shareCap);

  // 3) Diversity (Safeguard #3) — bucket share cap.
  const dims = Array.isArray(diversityCfg.dimensions) && diversityCfg.dimensions.length
    ? diversityCfg.dimensions
    : ['category', 'region', 'publisher'];
  const maxBucketShare =
    diversityCfg.enabled !== false && Number.isFinite(diversityCfg.maxBucketSharePct)
      ? diversityCfg.maxBucketSharePct / 100
      : 0;
  enforceDiversity(targets, dims, maxBucketShare);

  // 4) Floor + monotonic invariant (cap never below what was already delivered).
  return targets.map((t) => {
    const delivered = deliveredById.get(t.itemId) || 0;
    let cap = Math.max(0, Math.round(t.cap));
    cap = Math.max(cap, delivered); // MONOTONIC: never strand already-delivered views
    const floor = Math.min(t.weight > 0 ? minViews : 0, cap);
    return { itemId: t.itemId, score: t.weight, cap, floor, bucket: t.bucket };
  });
}

/**
 * Compute the per-item synthetic delta for one cycle.
 *
 * @param {object} params
 *   @param {Array}  params.states  [{itemId, cap, floor, deliveredTotal, cooldownUntilCycle, bucket}]
 *   @param {object} params.campaign { durationMinutes, curve:{burstAlpha,taperBeta,jitterPct,maxStepMultiplier}, cooldown:{enabled,restCycles} }
 *   @param {object} params.timing  { cycleIndex, elapsedMs, totalMs }
 * @returns {{cycleIndex, itemsAffected, totalIncrement, deltas:Array}}
 */
function computeCycleDeltas(params = {}) {
  const states = Array.isArray(params.states) ? params.states : [];
  const campaign = params.campaign || {};
  const timing = params.timing || {};

  const cycleIndex = Number.isFinite(timing.cycleIndex) ? timing.cycleIndex : 0;
  const elapsedMs = toInt(timing.elapsedMs);
  const totalMs = toInt(timing.totalMs);

  const curveCfg = campaign.curve || {};
  const alpha = posNum(curveCfg.burstAlpha, curve.DEFAULT_ALPHA);
  const beta = posNum(curveCfg.taperBeta, curve.DEFAULT_BETA);
  const jitterPct = Math.max(0, Number(curveCfg.jitterPct) || 0);
  const maxStepMult = posNum(curveCfg.maxStepMultiplier, 4);

  const cooldownCfg = campaign.cooldown || {};
  const restCycles =
    cooldownCfg.enabled === false ? 0 : Math.max(0, toInt(cooldownCfg.restCycles));

  const totalCycles = Math.max(1, toInt(campaign.durationMinutes));

  const deltas = [];
  let totalIncrement = 0;
  let itemsAffected = 0;

  for (const s of states) {
    const itemId = String(s.itemId);
    const cap = Math.max(0, toInt(s.cap));
    const delivered = Math.max(0, toInt(s.deliveredTotal));
    const cooldownUntil = toInt(s.cooldownUntilCycle);

    // Cooldown (Safeguard #2): resting => no boost this cycle, state unchanged.
    if (cooldownCfg.enabled !== false && cooldownUntil > cycleIndex) {
      deltas.push({
        itemId,
        delta: 0,
        newDeliveredTotal: delivered,
        cooldownUntilCycle: cooldownUntil,
        boosted: false
      });
      continue;
    }

    // Time-anchored expected cumulative for this item's cap (self-correcting).
    const expected = curve.expectedCumulative(cap, elapsedMs, totalMs, { alpha, beta });
    let raw = expected - delivered;

    // Deterministic jitter => varied yet reproducible increments.
    raw *= seededJitter(itemId, cycleIndex, jitterPct);

    // Monotonic: never negative.
    let delta = raw > 0 ? raw : 0;

    // Max-step smoothing: no sudden jumps. Allow catch-up up to maxStepMult x average.
    const maxStep = Math.max(1, (cap / totalCycles) * maxStepMult);
    if (delta > maxStep) delta = maxStep;

    delta = Math.round(delta);

    // Hard budget cap: never exceed this item's cap.
    const room = cap - delivered;
    if (delta > room) delta = room;
    if (delta < 0) delta = 0;

    const boosted = delta > 0;
    const newCooldownUntil = boosted && restCycles > 0 ? cycleIndex + restCycles : cooldownUntil;

    if (boosted) {
      itemsAffected++;
      totalIncrement += delta;
    }

    deltas.push({
      itemId,
      delta,
      newDeliveredTotal: delivered + delta,
      cooldownUntilCycle: newCooldownUntil,
      boosted
    });
  }

  return { cycleIndex, itemsAffected, totalIncrement, deltas };
}

module.exports = {
  allocateTargets,
  computeCycleDeltas,
  // exported for tests
  seededJitter,
  enforceDiversity
};
