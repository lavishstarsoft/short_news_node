'use strict';

/**
 * Phase-3B.5 — Semantic shadow metric schema (IDs / scores / timings only).
 * Never stores title, content, or article body.
 */

const C = require('./constants');

function asNumberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asStringOrNull(v) {
  if (v == null || v === '') return null;
  return String(v);
}

/**
 * Build a persistable shadow metric document (no article text fields).
 */
function buildShadowMetric(input = {}) {
  const exact = input.exact || {};
  const near = input.near || {};
  const semantic = input.semantic || {};
  const latency = input.latency || {};
  const comparison = input.comparison || {};

  return {
    requestId: asStringOrNull(input.requestId),
    newsId: asStringOrNull(input.newsId),
    language: (input.language || 'te').toLowerCase(),
    embeddingVersion: input.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION,
    modelId: input.modelId || C.DEFAULT_MODEL_ID,
    source: input.source === 'ai' ? 'ai' : 'legacy',
    status: input.status || 'ok',
    errorCode: asStringOrNull(input.errorCode),

    exactScore: asNumberOrNull(exact.score),
    exactMatched: exact.matched === true,
    exactCandidateId: asStringOrNull(exact.candidateId),

    nearScore: asNumberOrNull(near.score),
    nearCandidateId: asStringOrNull(near.candidateId),
    nearMatchCount: typeof near.matchCount === 'number' ? near.matchCount : 0,

    semanticScore: asNumberOrNull(semantic.score),
    semanticCandidateId: asStringOrNull(semantic.candidateId),
    semanticMatchCount:
      typeof semantic.matchCount === 'number' ? semantic.matchCount : 0,

    latencyMs: asNumberOrNull(latency.total),
    embedLatencyMs: asNumberOrNull(latency.embed),
    vectorSearchLatencyMs: asNumberOrNull(latency.vectorSearch),

    semanticAgreesWithExact:
      comparison.semanticAgreesWithExact == null
        ? null
        : comparison.semanticAgreesWithExact === true,
    semanticAgreesWithNear:
      comparison.semanticAgreesWithNear == null
        ? null
        : comparison.semanticAgreesWithNear === true,

    createdAt: input.createdAt || new Date(),
  };
}

/**
 * Ensure metric never carries article text keys.
 */
function assertMetricHasNoArticleText(metric) {
  const forbidden = ['title', 'content', 'body', 'articleTitle', 'articleBody', 'text'];
  for (const key of forbidden) {
    if (
      Object.prototype.hasOwnProperty.call(metric, key) &&
      metric[key] != null
    ) {
      return { ok: false, error: `metric must not include ${key}` };
    }
  }
  return { ok: true };
}

module.exports = {
  buildShadowMetric,
  assertMetricHasNoArticleText,
};
