'use strict';

/**
 * Phase-0 Same-Event SHADOW — fire-and-forget scheduler.
 *
 * SAFETY:
 *  - No-op unless DUP_SAMEEVENT_SHADOW_ENABLED=true (default OFF).
 *  - Runs AFTER the HTTP response (called from the existing reporter scan) →
 *    zero submission latency.
 *  - Writes ONLY the additive DuplicateShadowMetric collection (and, if
 *    DUP_SAMEEVENT_SHADOW_WRITE_NEWS=true, an additive News.duplicateCheck.shadow
 *    sub-field guarded on contentHash). It NEVER changes isDuplicate/isSuspicious/
 *    score/similarArticles/isActive/aiStatus/rejectionStatus.
 *  - Never throws (fully swallowed) — cannot affect production flow.
 */

const { loadShadowFlags } = require('./flags');
const { evaluateShadow } = require('./shadowEvaluator');
const { loadAiConfig } = require('../config');
const { createAiLogger } = require('../logger');
const C = require('../semantic/constants');

const logger = createAiLogger({ isEnabled: () => true });

/** Default query-embedding resolver: reuse a stored READY vector, else /v1/embed. */
function createDefaultGetQueryEmbedding(deps = {}) {
  const env = deps.env || process.env;
  return async function getQueryEmbedding(news) {
    try {
      const NewsVector = deps.NewsVector || require('../../../models/NewsVector');
      const existing = await NewsVector.findOne({
        newsId: news._id,
        status: C.STATUS.READY,
      })
        .select('embedding')
        .lean();
      if (existing && Array.isArray(existing.embedding) && existing.embedding.length) {
        return { embedding: existing.embedding, source: 'stored_vector' };
      }
    } catch (_) { /* fall through to live embed */ }

    try {
      const cfg = loadAiConfig(env);
      if (!cfg.baseUrl || !cfg.apiKey) return { embedding: null, source: 'none' };
      const http = deps.http || require('axios');
      const resp = await http.post(
        `${cfg.baseUrl}/v1/embed`,
        {
          title: news.title || '',
          content: news.content || '',
          language: (news.language || 'te').toLowerCase(),
        },
        {
          timeout: 5000,
          headers: { 'Content-Type': 'application/json', 'X-AI-Service-Key': cfg.apiKey },
          validateStatus: () => true,
        }
      );
      if (resp.status >= 200 && resp.status < 300 && Array.isArray(resp.data && resp.data.embedding)) {
        return { embedding: resp.data.embedding, source: 'live_embed' };
      }
    } catch (_) { /* no embedding available — semantic bands simply won't apply */ }
    return { embedding: null, source: 'none' };
  };
}

async function runShadow(news, opts = {}) {
  const env = opts.env || process.env;
  const cfg = loadShadowFlags(env);
  if (!cfg.enabled) return { skipped: true, reason: 'disabled' };
  if (!news || !news._id) return { skipped: true, reason: 'missing_news' };

  const deps = {
    env,
    log: logger,
    News: opts.News || require('../../../models/News'),
    NewsVector: opts.NewsVector || require('../../../models/NewsVector'),
    getQueryEmbedding: opts.getQueryEmbedding || createDefaultGetQueryEmbedding({ env }),
  };

  const shadow = await evaluateShadow(
    { news, productionDuplicateCheck: opts.productionDuplicateCheck || news.duplicateCheck || null },
    deps,
    cfg
  );

  // Persist the additive metric (isolated collection). Never touches News decision.
  try {
    const DuplicateShadowMetric = opts.DuplicateShadowMetric || require('../../../models/DuplicateShadowMetric');
    await DuplicateShadowMetric.create({
      newsId: news._id,
      version: shadow.version,
      language: shadow.language,
      authorId: news.authorId != null ? String(news.authorId) : null,
      location: news.location || null,
      newsPublishedAt: news.publishedAt || null,
      verdict: shadow.verdict,
      verdictGuarded: shadow.verdictGuarded,
      confidence: shadow.confidence,
      topSignals: shadow.signals || {},
      productionVerdict: shadow.productionVerdict,
      differsFromProduction: shadow.differsFromProduction,
      candidateStats: shadow.candidateStats,
      queryEmbeddingAvailable: !!(shadow.queryEmbedding && shadow.queryEmbedding.available),
      referenceMatches: shadow.referenceMatches,
      generatedAt: shadow.generatedAt,
    });
  } catch (err) {
    logger.warn('sameevent-shadow metric write failed', { newsId: String(news._id), error: err && err.message });
  }

  // OPTIONAL additive mirror onto News.duplicateCheck.shadow (guarded on
  // contentHash so a concurrent edit is never clobbered). Never sets decision
  // fields. OFF by default.
  if (cfg.writeNews) {
    try {
      const News = deps.News;
      await News.updateOne(
        { _id: news._id, contentHash: news.contentHash },
        {
          $set: {
            'duplicateCheck.shadow': {
              enabled: true,
              version: shadow.version,
              verdict: shadow.verdict,
              verdictGuarded: shadow.verdictGuarded,
              confidence: shadow.confidence,
              signals: shadow.signals || null,
              productionVerdict: shadow.productionVerdict,
              differsFromProduction: shadow.differsFromProduction,
              referenceMatchIds: (shadow.referenceMatches || []).map((m) => ({
                newsId: m.newsId,
                referenceOnly: m.referenceOnly,
                verdictGuarded: m.verdictGuarded,
                confidence: m.confidence,
              })),
              generatedAt: shadow.generatedAt,
            },
          },
        }
      );
    } catch (err) {
      logger.warn('sameevent-shadow News mirror failed', { newsId: String(news._id), error: err && err.message });
    }
  }

  return { skipped: false, shadow };
}

/** Fire-and-forget entry point — safe to call unconditionally. */
function scheduleSameEventShadow(news, opts = {}) {
  try {
    if (!loadShadowFlags(opts.env || process.env).enabled) return; // cheap early exit
  } catch (_) { return; }
  Promise.resolve()
    .then(() => runShadow(news, opts))
    .catch((err) => {
      try { logger.warn('sameevent-shadow unhandled', { error: err && err.message }); } catch (_) {}
    });
}

module.exports = { scheduleSameEventShadow, runShadow, createDefaultGetQueryEmbedding };
