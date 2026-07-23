'use strict';

/**
 * Semantic feature flags — Phase-3B.1 / 3B.5.
 * Defaults OFF. Shadow never changes user-facing duplicate decisions.
 */

const C = require('./constants');

function parseBoolFlag(raw) {
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function loadSemanticFeatureFlag(env = process.env) {
  const raw = env[C.ENV_SEMANTIC_ENABLED];
  const enabled = parseBoolFlag(raw);
  return {
    enabled,
    raw: raw === undefined ? null : String(raw),
    source: 'env',
    key: C.ENV_SEMANTIC_ENABLED,
    /** Advisory compute only (3B.6). Does not change duplicateCheck / gateway output. */
    note: 'AI_SEMANTIC_ENABLED gates semanticAdvisoryService only; Exact/Near remain authoritative',
  };
}

function isAiSemanticEnabled(env = process.env) {
  return loadSemanticFeatureFlag(env).enabled;
}

function loadSemanticShadowFeatureFlag(env = process.env) {
  const raw = env[C.ENV_SEMANTIC_SHADOW_ENABLED];
  const enabled = parseBoolFlag(raw);
  return {
    enabled,
    raw: raw === undefined ? null : String(raw),
    source: 'env',
    key: C.ENV_SEMANTIC_SHADOW_ENABLED,
    note:
      'When true, semantic shadow may run for metrics only. Never mutates duplicateCheck.',
  };
}

function isAiSemanticShadowEnabled(env = process.env) {
  return loadSemanticShadowFeatureFlag(env).enabled;
}

function loadEmbedWorkerFeatureFlag(env = process.env) {
  const raw = env[C.ENV_EMBED_WORKER_ENABLED];
  const enabled = parseBoolFlag(raw);
  return {
    enabled,
    raw: raw === undefined ? null : String(raw),
    source: 'env',
    key: C.ENV_EMBED_WORKER_ENABLED,
    note:
      'When true, background worker may process PENDING news_vectors. Does not change duplicate decisions.',
  };
}

function isAiEmbedWorkerEnabled(env = process.env) {
  return loadEmbedWorkerFeatureFlag(env).enabled;
}

module.exports = {
  loadSemanticFeatureFlag,
  isAiSemanticEnabled,
  loadSemanticShadowFeatureFlag,
  isAiSemanticShadowEnabled,
  loadEmbedWorkerFeatureFlag,
  isAiEmbedWorkerEnabled,
};
