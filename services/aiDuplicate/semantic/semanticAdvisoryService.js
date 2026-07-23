'use strict';

/**
 * Phase-3B.6 — Semantic Advisory ONLY.
 *
 * Embed → Vector Search → filter/rank → advisory object.
 * Never overrides Exact/Near. Never mutates duplicateCheck / News / gateway output.
 * Fail-open: any error → available:false (no throw).
 */

const C = require('./constants');
const { isAiSemanticEnabled } = require('./flags');
const { createVectorSearchService } = require('./vectorSearchService');
const { loadAiConfig } = require('../config');
const { createAiLogger } = require('../logger');

function parseFloatEnv(raw, fallback) {
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseIntEnv(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Conservative defaults from Phase-3B.5.5 analysis (configurable via env).
 */
function loadAdvisoryThresholds(env = process.env) {
  const possible = parseFloatEnv(
    env.AI_SEMANTIC_SCORE_POSSIBLE,
    C.DEFAULT_SEMANTIC_SCORE_POSSIBLE
  );
  let strong = parseFloatEnv(
    env.AI_SEMANTIC_SCORE_STRONG,
    C.DEFAULT_SEMANTIC_SCORE_STRONG
  );
  if (strong < possible) {
    strong = possible;
  }
  return {
    possible,
    strong,
    topK: parseIntEnv(env.AI_SEMANTIC_TOP_K, C.DEFAULT_SEMANTIC_ADVISORY_TOP_K),
    minMargin: parseFloatEnv(
      env.AI_SEMANTIC_MIN_SCORE_MARGIN,
      C.DEFAULT_SEMANTIC_MIN_SCORE_MARGIN
    ),
  };
}

function emptyAdvisory(overrides = {}) {
  return {
    enabled: false,
    available: false,
    reason: null,
    topCandidate: null,
    candidates: [],
    modelId: null,
    embeddingVersion: null,
    latencyMs: 0,
    advisoryOnly: true,
    thresholds: null,
    ...overrides,
  };
}

function classifyStrength(score, thresholds) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score >= thresholds.strong) return 'strong';
  if (score >= thresholds.possible) return 'possible';
  return null;
}

/**
 * Keep same language + embeddingVersion only; apply score threshold; rank desc.
 */
function filterAndRankCandidates(matches, opts = {}) {
  const language = (opts.language || 'te').toLowerCase();
  const embeddingVersion =
    opts.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION;
  const thresholds = opts.thresholds || loadAdvisoryThresholds({});
  const excludeNewsId = opts.excludeNewsId
    ? String(opts.excludeNewsId)
    : null;

  const filtered = [];
  for (const m of matches || []) {
    if (!m || m.newsId == null) continue;
    const newsId = String(m.newsId);
    if (excludeNewsId && newsId === excludeNewsId) continue;

    const lang = m.language != null ? String(m.language).toLowerCase() : null;
    if (lang !== language) continue;

    const ver =
      m.embeddingVersion != null
        ? String(m.embeddingVersion)
        : null;
    if (ver !== embeddingVersion) continue;

    const score = typeof m.score === 'number' ? m.score : null;
    if (score == null || score < thresholds.possible) continue;

    const strength = classifyStrength(score, thresholds);
    if (!strength) continue;

    filtered.push({
      newsId,
      score,
      language: lang,
      publishedAt: m.publishedAt || null,
      strength,
    });
  }

  filtered.sort((a, b) => b.score - a.score);
  return filtered;
}

function createDefaultEmbedFn(deps = {}) {
  return async function embedText(payload = {}) {
    const env = deps.env || process.env;
    const cfg = loadAiConfig(env);
    const http = deps.http || require('axios');
    const timeoutMs =
      parseIntEnv(
        env.AI_SEMANTIC_ADVISORY_EMBED_TIMEOUT_MS,
        C.DEFAULT_SHADOW_EMBED_TIMEOUT_MS
      );

    if (!cfg.baseUrl || !cfg.apiKey) {
      return { ok: false, error: 'embed_config_missing' };
    }

    const started = Date.now();
    try {
      const response = await http.post(
        `${cfg.baseUrl}/v1/embed`,
        {
          title: payload.title || '',
          content: payload.content || '',
          language: payload.language || 'te',
        },
        {
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            'X-AI-Service-Key': cfg.apiKey,
            ...(payload.requestId
              ? { 'X-Request-Id': String(payload.requestId) }
              : {}),
          },
          validateStatus: () => true,
        }
      );

      const latencyMs = Date.now() - started;
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, error: `embed_http_${response.status}`, latencyMs };
      }
      const data = response.data || {};
      if (!Array.isArray(data.embedding)) {
        return { ok: false, error: 'embed_invalid_response', latencyMs };
      }
      return {
        ok: true,
        embedding: data.embedding,
        embeddingVersion: data.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION,
        modelId: data.modelId || C.DEFAULT_MODEL_ID,
        latencyMs,
      };
    } catch (_) {
      return {
        ok: false,
        error: 'embed_request_failed',
        latencyMs: Date.now() - started,
      };
    }
  };
}

function createSemanticAdvisoryService(deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  const thresholds = deps.thresholds || loadAdvisoryThresholds(env);
  const vectorSearch =
    deps.vectorSearch ||
    createVectorSearchService({
      collection: deps.collection,
      NewsVector: deps.NewsVector,
    });
  const embedText = deps.embedText || createDefaultEmbedFn({ env, http: deps.http });
  const log =
    deps.log ||
    createAiLogger({
      logger: deps.logger,
      isEnabled: () => isAiSemanticEnabled(env),
    });

  /**
   * Return advisory-only signal. Never throws. Never decides duplicates.
   */
  async function getSemanticAdvisory(input = {}) {
    const started = now();

    if (!isAiSemanticEnabled(env)) {
      return emptyAdvisory({
        enabled: false,
        available: false,
        reason: 'semantic_disabled',
        latencyMs: 0,
        thresholds,
      });
    }

    const language = (input.language || 'te').toLowerCase();
    const requestId = input.requestId != null ? String(input.requestId) : null;
    const excludeNewsId =
      input.excludeNewsId != null
        ? String(input.excludeNewsId)
        : input.newsId != null
          ? String(input.newsId)
          : null;

    const expectedVersion =
      input.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION;

    try {
      let embedding = Array.isArray(input.embedding) ? input.embedding : null;
      let modelId = C.DEFAULT_MODEL_ID;
      let embeddingVersion = expectedVersion;

      if (!embedding) {
        const embedResult = await embedText({
          title: input.title || '',
          content: input.content || '',
          language,
          requestId,
        });

        if (!embedResult.ok) {
          log.warn('Semantic advisory embed failed', {
            requestId,
            error: embedResult.error || 'embed_failed',
          });
          return emptyAdvisory({
            enabled: true,
            available: false,
            reason: embedResult.error || 'embed_failed',
            latencyMs: now() - started,
            thresholds,
          });
        }

        embedding = embedResult.embedding;
        modelId = embedResult.modelId || modelId;
        embeddingVersion =
          embedResult.embeddingVersion || embeddingVersion;
      }

      // Never search across versions
      if (embeddingVersion !== expectedVersion && input.embeddingVersion) {
        return emptyAdvisory({
          enabled: true,
          available: false,
          reason: 'embedding_version_mismatch',
          modelId,
          embeddingVersion,
          latencyMs: now() - started,
          thresholds,
        });
      }

      // Prefer query embedding version for search filter
      const searchVersion = embeddingVersion || expectedVersion;

      const vsResult = await vectorSearch.searchSimilar({
        embedding,
        language,
        embeddingVersion: searchVersion,
        topK: thresholds.topK,
        windowHours: input.windowHours,
        excludeNewsId,
        now: input.clock || new Date(),
      });

      if (!vsResult.ok) {
        log.warn('Semantic advisory vector search failed', {
          requestId,
          error: vsResult.error || 'vector_search_failed',
        });
        return emptyAdvisory({
          enabled: true,
          available: false,
          reason: vsResult.error || 'vector_search_failed',
          modelId,
          embeddingVersion: searchVersion,
          latencyMs: now() - started,
          thresholds,
        });
      }

      const candidates = filterAndRankCandidates(vsResult.matches || [], {
        language,
        embeddingVersion: searchVersion,
        thresholds,
        excludeNewsId,
      });

      const latencyMs = now() - started;

      if (candidates.length === 0) {
        return {
          enabled: true,
          available: true,
          reason: 'no_candidates_above_threshold',
          topCandidate: null,
          candidates: [],
          modelId,
          embeddingVersion: searchVersion,
          latencyMs,
          advisoryOnly: true,
          thresholds,
        };
      }

      const topCandidate = {
        newsId: candidates[0].newsId,
        score: candidates[0].score,
        language: candidates[0].language,
        publishedAt: candidates[0].publishedAt,
      };

      log.info('Semantic advisory ok', {
        requestId,
        language,
        embeddingVersion: searchVersion,
        modelId,
        topScore: topCandidate.score,
        candidateCount: candidates.length,
        latencyMs,
      });

      return {
        enabled: true,
        available: true,
        reason: null,
        topCandidate,
        candidates,
        modelId,
        embeddingVersion: searchVersion,
        latencyMs,
        advisoryOnly: true,
        thresholds,
      };
    } catch (err) {
      log.warn('Semantic advisory exception', {
        requestId,
        error: err && err.message ? err.message : 'unknown',
      });
      return emptyAdvisory({
        enabled: true,
        available: false,
        reason: 'advisory_exception',
        latencyMs: now() - started,
        thresholds,
      });
    }
  }

  return {
    getSemanticAdvisory,
    filterAndRankCandidates,
    loadAdvisoryThresholds: () => thresholds,
    isEnabled: () => isAiSemanticEnabled(env),
  };
}

const defaultService = createSemanticAdvisoryService();

module.exports = {
  createSemanticAdvisoryService,
  loadAdvisoryThresholds,
  filterAndRankCandidates,
  classifyStrength,
  emptyAdvisory,
  getSemanticAdvisory: defaultService.getSemanticAdvisory,
};
