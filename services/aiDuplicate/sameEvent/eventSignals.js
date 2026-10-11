'use strict';

/**
 * Phase-0 Same-Event SHADOW — pure signal + fusion helpers.
 *
 * PURE and side-effect free. Reuses the already-calibrated primitives from
 * semanticDecisionService (cosine, factTokens, factOverlap, verdictFor,
 * numberOverlap, applyTemplateVeto) and similarityDetector (cosineSimilarity,
 * tokenizeForSimilarity) — NO new thresholds are invented for the decision.
 *
 * The shadow produces TWO verdict variants for calibration:
 *   - verdict         = the reused calibrated semantic bands (verdictFor + vetoes)
 *   - verdictGuarded  = verdict, but a "duplicate" is DOWNGRADED to "suspicious"
 *                       when geo AND date agreement are both weak (precision
 *                       guard — can only downgrade, never upgrade).
 */

const {
  factTokens,
  factOverlap,
  numberOverlap,
  verdictFor,
  applyTemplateVeto,
} = require('../semantic/semanticDecisionService');
const { cosineSimilarity } = require('../../../utils/similarityDetector');

/** Normalise a free-text location into a comparable token set. */
function geoTokens(location) {
  const raw = String(location || '').toLowerCase();
  if (!raw) return new Set();
  // split on separators + strip common admin words; keep place tokens
  const parts = raw
    .split(/[\s,./|-]+/u)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s.length >= 2);
  return new Set(parts);
}

/** Jaccard over geo tokens → 0..1. 0 when either side has no location. */
function geoMatch(aLoc, bLoc) {
  const a = geoTokens(aLoc);
  const b = geoTokens(bLoc);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

/** Date proximity → 1.0 same instant, decays linearly to 0 at windowDays. */
function dateProximity(aDate, bDate, windowDays = 3) {
  const ta = aDate ? new Date(aDate).getTime() : NaN;
  const tb = bDate ? new Date(bDate).getTime() : NaN;
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  const diffDays = Math.abs(ta - tb) / (24 * 3600 * 1000);
  const w = windowDays > 0 ? windowDays : 3;
  return Math.max(0, Math.min(1, 1 - diffDays / w));
}

/** Non-number fact tokens (names/places/orgs) only. */
function wordTokens(tokenSet) {
  const out = new Set();
  for (const x of tokenSet) if (!String(x).startsWith('#')) out.add(x);
  return out;
}

/** IDF-weighted overlap restricted to entity/word tokens (excludes numbers). */
function entityOverlap(aTokens, bTokens, idf) {
  return factOverlap(wordTokens(aTokens), wordTokens(bTokens), idf);
}

/** Plain text cosine on title+content (reuses similarityDetector). 0..1. */
function textCosine(aTitle, aContent, bTitle, bContent) {
  const a = `${aTitle || ''} ${aContent || ''}`;
  const b = `${bTitle || ''} ${bContent || ''}`;
  return cosineSimilarity(a, b) / 100; // helper returns 0..100
}

/** Transparent 0..1 blend for RANKING/calibration only (never decides). */
function confidenceBlend(sig) {
  const sem = sig.semantic == null ? 0 : sig.semantic;
  const fact = sig.factOverlap || 0;
  const geo = sig.geoMatch || 0;
  const date = sig.dateProximity || 0;
  const c = 0.5 * sem + 0.3 * fact + 0.1 * geo + 0.1 * date;
  return Math.max(0, Math.min(1, c));
}

/**
 * Fuse signals into shadow verdicts. `thresholds` is the object returned by
 * semanticDecisionService.loadThresholds(env) — i.e. the EXISTING calibrated
 * bands. `guard` carries the precision-guard minimums (flags.geoGuardMin/…).
 */
function fuseVerdict(sig, thresholds, opts = {}) {
  const sem = sig.semantic;
  const fact = sig.factOverlap || 0;
  // Semantic bands require a semantic score; without an embedding, the reused
  // calibrated verdict is null (recorded as "different") — never invented.
  let verdict = null;
  if (typeof sem === 'number') {
    verdict = verdictFor(sem, fact, thresholds);
    verdict = applyTemplateVeto(verdict, sig.numberOverlap, !!opts.sameAuthor);
  }

  // Precision guard: only ever downgrade a duplicate when geo AND date are weak.
  let verdictGuarded = verdict;
  if (
    verdict === 'duplicate' &&
    (sig.geoMatch || 0) < (opts.geoGuardMin != null ? opts.geoGuardMin : 0.34) &&
    (sig.dateProximity || 0) < (opts.dateGuardMin != null ? opts.dateGuardMin : 0.5)
  ) {
    verdictGuarded = 'suspicious';
  }

  return {
    verdict: verdict || 'different',
    verdictGuarded: verdictGuarded || 'different',
    confidence: Number(confidenceBlend(sig).toFixed(4)),
  };
}

/** Strongest verdict across matches: duplicate > suspicious > different. */
function rollupVerdict(verdicts) {
  if (verdicts.some((v) => v === 'duplicate')) return 'duplicate';
  if (verdicts.some((v) => v === 'suspicious')) return 'suspicious';
  return 'different';
}

module.exports = {
  geoTokens,
  geoMatch,
  dateProximity,
  wordTokens,
  entityOverlap,
  textCosine,
  confidenceBlend,
  fuseVerdict,
  rollupVerdict,
  // re-exported for the evaluator/tests
  factTokens,
  factOverlap,
  numberOverlap,
};
