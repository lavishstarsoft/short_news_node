'use strict';

/**
 * Phase-0 Same-Event SHADOW — evaluator (COMPUTE-ONLY, never writes).
 *
 * Retrieves bounded candidates (incl. rejected references), computes all
 * signals, fuses them into shadow verdicts using the EXISTING calibrated
 * semantic bands, and returns a shadow object + stats. It does NOT touch News,
 * status, rejectionStatus, isActive, aiStatus, or the production duplicateCheck.
 */

const S = require('./eventSignals');
const { retrieveCandidates } = require('./candidateRetrieval');
const {
  cosine,
  buildIdf,
  loadThresholds,
} = require('../semantic/semanticDecisionService');

const SHADOW_VERSION = 'sameevent-shadow-v1';

/** Map an existing production duplicateCheck → a comparable verdict. */
function productionVerdictOf(dc) {
  if (!dc) return 'different';
  if (dc.isDuplicate === true) return 'duplicate';
  if (dc.isSuspicious === true) return 'suspicious';
  return 'different';
}

function reasonFor(verdict, sig) {
  if (verdict === 'duplicate') return 'Meaning + shared facts indicate the same event.';
  if (verdict === 'suspicious') return 'Possible same event — needs human review.';
  if ((sig.semantic || 0) >= 0.9) return 'Similar meaning but distinct facts/place — likely different event.';
  return 'Not similar enough to be the same event.';
}

/**
 * @param {object} input { news, productionDuplicateCheck }
 * @param {object} deps  { News, NewsVector, getQueryEmbedding(news)->{embedding}, env, log }
 * @param {object} cfg   flags (loadShadowFlags)
 */
async function evaluateShadow(input, deps, cfg) {
  const news = input.news || {};
  const env = deps.env || process.env;
  const log = deps.log || { info() {}, warn() {} };
  const thresholds = deps.thresholds || loadThresholds(env);

  const { candidates, stats } = await retrieveCandidates(
    { language: news.language, excludeId: news._id },
    deps,
    cfg
  );

  // Query embedding (optional — semantic bands only apply when present).
  let qEmb = null;
  let qEmbSource = 'none';
  try {
    const r = deps.getQueryEmbedding ? await deps.getQueryEmbedding(news) : null;
    if (r && Array.isArray(r.embedding) && r.embedding.length) {
      qEmb = r.embedding;
      qEmbSource = r.source || 'embed';
    }
  } catch (_) { qEmb = null; }

  const qFact = S.factTokens(news.title, news.content);
  const tokenSets = candidates.map((c) => {
    c._fact = S.factTokens(c.title, c.content);
    return c._fact;
  });
  const idf = buildIdf([...tokenSets, qFact]);

  const excludeId = news._id != null ? String(news._id) : null;
  const scored = [];
  for (const c of candidates) {
    if (excludeId && String(c.newsId) === excludeId) continue;
    const sem =
      qEmb && Array.isArray(c.embedding) && c.embedding.length === qEmb.length
        ? cosine(qEmb, c.embedding)
        : null;
    const fact = S.factOverlap(qFact, c._fact, idf);
    const geo = S.geoMatch(news.location, c.location);
    const date = S.dateProximity(news.publishedAt, c.publishedAt, cfg.dateWindowDays);
    const entity = S.entityOverlap(qFact, c._fact, idf);
    const text = S.textCosine(news.title, news.content, c.title, c.content);
    const numOv = S.numberOverlap(qFact, c._fact);
    const sameAuthor = !!(news.authorId && c.authorId && String(news.authorId) === String(c.authorId));

    const sig = {
      semantic: sem == null ? null : Number(sem.toFixed(4)),
      factOverlap: Number(fact.toFixed(4)),
      geoMatch: Number(geo.toFixed(4)),
      dateProximity: Number(date.toFixed(4)),
      entityOverlap: Number(entity.toFixed(4)),
      textCosine: Number(text.toFixed(4)),
      numberOverlap: numOv == null ? null : Number(numOv.toFixed(4)),
    };
    const fused = S.fuseVerdict(sig, thresholds, {
      sameAuthor,
      geoGuardMin: cfg.geoGuardMin,
      dateGuardMin: cfg.dateGuardMin,
    });

    const interesting =
      fused.verdict !== 'different' ||
      fused.verdictGuarded !== 'different' ||
      (sem != null && sem >= (thresholds.minSem || 0.9)) ||
      text >= 0.55;
    if (!interesting) continue;

    scored.push({
      newsId: String(c.newsId),
      referenceOnly: !!c.referenceOnly,
      source: c.source,
      sameAuthor,
      verdict: fused.verdict,
      verdictGuarded: fused.verdictGuarded,
      confidence: fused.confidence,
      similarity: sig,
      reason: reasonFor(fused.verdictGuarded, sig),
    });
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  const referenceMatches = scored.slice(0, cfg.topK);

  const verdict = S.rollupVerdict(referenceMatches.map((m) => m.verdict));
  const verdictGuarded = S.rollupVerdict(referenceMatches.map((m) => m.verdictGuarded));
  const confidence = referenceMatches.length ? referenceMatches[0].confidence : 0;
  const productionVerdict = productionVerdictOf(input.productionDuplicateCheck);

  const shadow = {
    enabled: true,
    version: SHADOW_VERSION,
    generatedAt: new Date(),
    language: String(news.language || 'te').toLowerCase(),
    verdict, // reused calibrated semantic bands
    verdictGuarded, // + geo/date precision guard
    confidence,
    signals: referenceMatches.length ? referenceMatches[0].similarity : null,
    queryEmbedding: { available: !!qEmb, source: qEmbSource },
    candidateStats: stats,
    productionVerdict,
    differsFromProduction: productionVerdict !== verdictGuarded,
    referenceMatches,
  };

  log.info('sameevent-shadow', {
    newsId: excludeId,
    language: shadow.language,
    candidates: stats.merged,
    rejectedReferences: stats.rejectedReferences,
    vectorCandidates: stats.vectorCandidates,
    eventCandidates: stats.eventCandidates,
    withEmbedding: stats.withEmbedding,
    verdict,
    verdictGuarded,
    confidence,
    productionVerdict,
    differs: shadow.differsFromProduction,
    topRefs: referenceMatches.slice(0, 3).map((m) => m.newsId),
  });

  return shadow;
}

module.exports = { evaluateShadow, productionVerdictOf, reasonFor, SHADOW_VERSION };
