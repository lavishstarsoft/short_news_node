'use strict';

/**
 * signalProvider.js — the engine's ONLY window into news signals.
 *
 * Responsibilities
 *   1. Resolve the eligible candidate set for a campaign (index-backed, bounded).
 *   2. Extract raw per-item signals from PRISTINE News fields.
 *   3. Normalize them into a stable FeatureVector for the AllocationStrategy.
 *
 * Hard rules
 *   - READ-ONLY on News. Never writes. Never reads `syntheticViews` for scoring
 *     (organic only) — synthetic is display-layer concern, not a signal.
 *   - Grounded in fields that actually exist on News: publishedAt, likes,
 *     dislikes, comments, views, category, location, scope, authorId.
 *   - `editorPriority` / `isBreaking` do NOT exist on News today, so they are
 *     read OPTIONALLY and default to neutral. If you add those fields later the
 *     engine picks them up automatically — no code change (Open/Closed).
 *   - Centralizing all reads here is what guarantees "analytics/fraud/ML use
 *     organic only": there is exactly one place that reads news for the engine.
 *
 * Scalability
 *   - Eligibility uses existing compound indexes
 *     ({language|category|scope, isActive, publishedAt}) + a hard `itemCap` limit,
 *     so cost is O(itemCap) regardless of catalogue size (millions-safe).
 *   - `.lean()` + tight projection => minimal BSON + no hydration overhead.
 */

const News = require('../../models/News');
const { LOG_PREFIX } = require('./constants');

// Scope importance heuristic (a gentle multiplier, NOT a hard priority).
// Wider-reach stories get a slight edge; spread kept small to avoid dominance.
const SCOPE_WEIGHTS = { district: 1.0, state: 1.05, national: 1.2, international: 1.2 };
const DEFAULT_SCOPE_WEIGHT = 1.0;

// Freshness decay constant (hours). recency = e^(-ageHours / TAU).
const FRESHNESS_TAU_HOURS = 24;

// Only the fields we actually need — keeps the working set tiny at scale.
const PROJECTION =
  '_id category location scope language publishedAt likes dislikes comments views authorId editorPriority isBreaking';

/**
 * Build the Mongo eligibility filter from a campaign's coarse inputs.
 * Uses only pristine fields so it rides existing indexes.
 */
function buildEligibilityQuery(campaign, now = new Date()) {
  const q = {
    isActive: true,
    'rejectionStatus.isRejected': { $ne: true },
    $or: [
      { viewEngineCampaignId: null },
      { viewEngineCampaignId: { $exists: false } }
    ]
  };
  
  if (campaign && campaign._id) {
    q.$or.push({ viewEngineCampaignId: campaign._id });
  }
  const e = (campaign && campaign.eligibility) || {};
  if (Array.isArray(e.languages) && e.languages.length) q.language = { $in: e.languages };
  if (Array.isArray(e.categories) && e.categories.length) q.category = { $in: e.categories };
  if (Array.isArray(e.scopes) && e.scopes.length) q.scope = { $in: e.scopes };
  if (Number.isFinite(e.maxAgeHours) && e.maxAgeHours > 0) {
    q.publishedAt = { $gte: new Date(now.getTime() - e.maxAgeHours * 3600 * 1000) };
  }
  return q;
}

/**
 * Fetch the bounded candidate set (most-recent-first within eligibility).
 *
 * Design note: we take the newest `itemCap` eligible items rather than scanning
 * everything and ranking — freshness is a first-class signal and `maxAgeHours`
 * already bounds relevance, so this stays index-backed and O(itemCap). A future
 * strategy can widen the pool without changing this contract.
 *
 * @returns {Promise<Array>} lean News docs (empty array on any error — fail safe).
 */
async function fetchCandidates(campaign, now = new Date()) {
  try {
    const cap = Math.max(1, Number(campaign && campaign.itemCap) || 500);
    const query = buildEligibilityQuery(campaign, now);
    const docs = await News.find(query)
      .select(PROJECTION)
      .sort({ publishedAt: -1 })
      .limit(cap)
      .lean();
    console.log(`${LOG_PREFIX} signalProvider: ${docs.length} eligible candidates (cap ${cap})`);
    return docs;
  } catch (err) {
    // Fail safe: no candidates => the caller simply skips this cycle.
    console.error(`${LOG_PREFIX} signalProvider.fetchCandidates error:`, err.message);
    return [];
  }
}

// ---- pure helpers (unit-testable, no IO) --------------------------------

function toInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/** Min-max normalize an array to [0,1]; uniform inputs => neutral 0.5. */
function minMaxNormalize(values) {
  if (!values.length) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range <= 0) return values.map(() => 0.5);
  return values.map((v) => (v - min) / range);
}

/** Extract raw (un-normalized) signals from one lean News doc. */
function extractRawSignals(doc, now = new Date()) {
  const publishedAt = doc.publishedAt ? new Date(doc.publishedAt).getTime() : now.getTime();
  const ageHours = Math.max(0, (now.getTime() - publishedAt) / 3600000);
  const organicViews = toInt(doc.views); // PRISTINE organic — never syntheticViews
  const likes = toInt(doc.likes);
  const comments = toInt(doc.comments);

  return {
    itemId: String(doc._id),
    organicNow: organicViews,
    ageHours,
    // engagement magnitude (organic only); log-damped so mega-hits don't swamp
    engagementRaw: Math.log1p(likes + comments + organicViews),
    recency: Math.exp(-ageHours / FRESHNESS_TAU_HOURS), // already in (0,1]
    scopeWeight: SCOPE_WEIGHTS[doc.scope] || DEFAULT_SCOPE_WEIGHT,
    categoryWeight: 1.0, // neutral placeholder; a campaign-level map can override later
    // OPTIONAL signals — fields absent on News today; default neutral.
    breaking: doc.isBreaking === true ? 1 : 0,
    priority: Number.isFinite(doc.editorPriority) ? Math.max(0, Math.min(1, doc.editorPriority / 10)) : 0,
    bucket: {
      category: doc.category || 'unknown',
      region: doc.location || doc.scope || 'unknown',
      publisher: String(doc.authorId || 'unknown')
    }
  };
}

/**
 * Turn lean candidate docs into normalized FeatureVectors.
 *
 * @param {Array} docs               lean News docs from fetchCandidates()
 * @param {object} opts
 *   @param {Date}   opts.now
 *   @param {Map}    opts.priorStateById  Map<itemId,{organicBaseline,lastRebalanceAt}>
 *                                        used to compute organic VELOCITY on rebalance.
 * @returns {Array<FeatureVector>}
 */
function computeFeatureVectors(docs, opts = {}) {
  const now = opts.now || new Date();
  const priorStateById = opts.priorStateById || new Map();
  if (!Array.isArray(docs) || !docs.length) return [];

  const raws = docs.map((d) => extractRawSignals(d, now));

  // Organic velocity (Δ organic views / minute since last snapshot). First
  // snapshot has no baseline => 0. Uses organic `views` ONLY.
  const velocityRaw = raws.map((r) => {
    const prior = priorStateById.get(r.itemId);
    if (!prior || !prior.lastRebalanceAt) return 0;
    const mins = Math.max(1, (now.getTime() - new Date(prior.lastRebalanceAt).getTime()) / 60000);
    return Math.max(0, r.organicNow - toInt(prior.organicBaseline)) / mins;
  });

  const engagementNorm = minMaxNormalize(raws.map((r) => r.engagementRaw));
  const velocityNorm = minMaxNormalize(velocityRaw);

  return raws.map((r, i) => ({
    itemId: r.itemId,
    organicNow: r.organicNow,
    bucket: r.bucket,
    features: {
      freshness: r.recency, // bounded (0,1], no normalization needed
      engagement: engagementNorm[i],
      velocity: velocityNorm[i],
      scopeWeight: r.scopeWeight,
      categoryWeight: r.categoryWeight,
      breaking: r.breaking,
      priority: r.priority
    }
  }));
}

module.exports = {
  buildEligibilityQuery,
  fetchCandidates,
  extractRawSignals,
  computeFeatureVectors,
  // exported for tests / reuse
  minMaxNormalize,
  SCOPE_WEIGHTS,
  FRESHNESS_TAU_HOURS
};
