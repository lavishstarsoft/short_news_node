'use strict';

/**
 * Phase-3B.5 — Semantic Shadow Evaluation ONLY.
 *
 * Exact + Near + Semantic → Compare → Metrics.
 * Never decides duplicates. Never mutates duplicateCheck / News / API responses.
 * Executes only when AI_SEMANTIC_SHADOW_ENABLED=true.
 */

const C = require('./constants');
const { isAiSemanticShadowEnabled } = require('./flags');
const {
  buildShadowMetric,
  assertMetricHasNoArticleText,
} = require('./semanticShadowMetricContract');
const { createSemanticShadowStore } = require('./semanticShadowStore');
const { createVectorSearchService } = require('./vectorSearchService');
const { loadAiConfig } = require('../config');
const { createAiLogger } = require('../logger');

/**
 * Derive Exact/Near score snapshots from AI detect payload and/or legacy duplicateCheck.
 * Never copies title/content fields into the snapshot.
 */
function extractExactNearSnapshots(input = {}) {
  const aiExact = input.aiExact || null;
  const aiNear = input.aiNear || null;
  const dc = input.duplicateCheck || {};
  const articles = Array.isArray(dc.similarArticles) ? dc.similarArticles : [];

  let exact = {
    matched: false,
    score: null,
    candidateId: null,
  };
  let near = {
    score: null,
    candidateId: null,
    matchCount: 0,
  };

  if (aiExact && typeof aiExact === 'object') {
    exact = {
      matched: aiExact.matched === true,
      score: typeof aiExact.score === 'number' ? aiExact.score : exact.matched ? 100 : 0,
      candidateId:
        aiExact.matched_candidate_id != null
          ? String(aiExact.matched_candidate_id)
          : null,
    };
  } else if (articles.length > 0) {
    const top = articles[0];
    const overall =
      top && top.similarity && typeof top.similarity.overall === 'number'
        ? top.similarity.overall
        : null;
    if (top && top.isDuplicate === true && overall === 100) {
      exact = {
        matched: true,
        score: 100,
        candidateId: top.articleId != null ? String(top.articleId) : null,
      };
    }
  }

  if (aiNear && typeof aiNear === 'object') {
    const matches = Array.isArray(aiNear.matches) ? aiNear.matches : [];
    const best =
      typeof aiNear.best_score === 'number'
        ? aiNear.best_score
        : matches[0] && typeof matches[0].score === 'number'
          ? matches[0].score
          : null;
    const topId =
      matches[0] && matches[0].candidate_id != null
        ? String(matches[0].candidate_id)
        : null;
    near = {
      score: best,
      candidateId: topId,
      matchCount: matches.length,
    };
  } else {
    const nearArticles = articles.filter((a) => !(a.isDuplicate === true && a.similarity && a.similarity.overall === 100));
    const pool = nearArticles.length > 0 ? nearArticles : articles;
    near = {
      score:
        pool[0] && pool[0].similarity && typeof pool[0].similarity.overall === 'number'
          ? pool[0].similarity.overall
          : typeof dc.score === 'number'
            ? dc.score
            : null,
      candidateId:
        pool[0] && pool[0].articleId != null ? String(pool[0].articleId) : null,
      matchCount: pool.length,
    };
  }

  return { exact, near };
}

function compareResults(exact, near, semantic) {
  const semId = semantic.candidateId;
  const exactId = exact.candidateId;
  const nearId = near.candidateId;

  return {
    semanticAgreesWithExact:
      semId && exactId ? semId === exactId : null,
    semanticAgreesWithNear:
      semId && nearId ? semId === nearId : null,
  };
}

function createDefaultEmbedFn(deps = {}) {
  return async function embedText(payload = {}) {
    const env = deps.env || process.env;
    const cfg = loadAiConfig(env);
    const http = deps.http || require('axios');
    const timeoutMs =
      Number.parseInt(env.AI_SEMANTIC_SHADOW_EMBED_TIMEOUT_MS || '', 10) ||
      C.DEFAULT_SHADOW_EMBED_TIMEOUT_MS;

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
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? 'embed_request_failed' : 'embed_request_failed',
        latencyMs: Date.now() - started,
      };
    }
  };
}

function createSemanticShadowService(deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  const store = deps.store || createSemanticShadowStore({
    SemanticShadowMetric: deps.SemanticShadowMetric,
  });
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
      isEnabled: () => isAiSemanticShadowEnabled(env),
    });

  /**
   * Run shadow evaluation. Does not return/alter duplicate decisions.
   */
  async function evaluate(input = {}) {
    if (!isAiSemanticShadowEnabled(env)) {
      return { executed: false, reason: 'shadow_disabled', metric: null };
    }

    const started = now();
    const language = (input.language || 'te').toLowerCase();
    const requestId = input.requestId != null ? String(input.requestId) : null;
    const newsId = input.newsId != null ? String(input.newsId) : null;
    const source = input.source === 'ai' ? 'ai' : 'legacy';

    const { exact, near } = extractExactNearSnapshots(input);

    let embedLatencyMs = null;
    let vectorSearchLatencyMs = null;
    let embeddingVersion = C.DEFAULT_EMBEDDING_VERSION;
    let modelId = C.DEFAULT_MODEL_ID;
    let semantic = {
      score: null,
      candidateId: null,
      matchCount: 0,
    };
    let status = 'ok';
    let errorCode = null;

    try {
      let embedding = Array.isArray(input.embedding) ? input.embedding : null;

      if (!embedding) {
        const embedStarted = now();
        const embedResult = await embedText({
          title: input.title || '',
          content: input.content || '',
          language,
          requestId,
        });
        embedLatencyMs =
          typeof embedResult.latencyMs === 'number'
            ? embedResult.latencyMs
            : now() - embedStarted;

        if (!embedResult.ok) {
          status = 'error';
          errorCode = embedResult.error || 'embed_failed';
        } else {
          embedding = embedResult.embedding;
          embeddingVersion =
            embedResult.embeddingVersion || embeddingVersion;
          modelId = embedResult.modelId || modelId;
        }
      }

      if (status === 'ok' && embedding) {
        const vsStarted = now();
        const vsResult = await vectorSearch.searchSimilar({
          embedding,
          language,
          embeddingVersion,
          topK: input.topK || C.DEFAULT_SHADOW_TOP_K,
          windowHours: input.windowHours,
          excludeNewsId: newsId,
          now: input.clock || new Date(),
        });
        vectorSearchLatencyMs = now() - vsStarted;

        if (!vsResult.ok) {
          status = 'error';
          errorCode = vsResult.error || 'vector_search_failed';
        } else {
          const matches = vsResult.matches || [];
          semantic = {
            score: matches[0] ? matches[0].score : null,
            candidateId: matches[0] ? matches[0].newsId : null,
            matchCount: matches.length,
          };
          if (vsResult.meta && vsResult.meta.embeddingVersion) {
            embeddingVersion = vsResult.meta.embeddingVersion;
          }
        }
      }
    } catch (err) {
      status = 'error';
      errorCode = 'shadow_exception';
      log.warn('Semantic shadow exception', {
        requestId,
        newsId,
        error: err && err.message ? err.message : 'unknown',
      });
    }

    const comparison = compareResults(exact, near, semantic);
    const metric = buildShadowMetric({
      requestId,
      newsId,
      language,
      embeddingVersion,
      modelId,
      source,
      status,
      errorCode,
      exact,
      near,
      semantic,
      comparison,
      latency: {
        total: now() - started,
        embed: embedLatencyMs,
        vectorSearch: vectorSearchLatencyMs,
      },
    });

    const textCheck = assertMetricHasNoArticleText(metric);
    if (!textCheck.ok) {
      return { executed: true, reason: 'metric_rejected', metric: null, error: textCheck.error };
    }

    let persist = { ok: false };
    try {
      persist = await store.saveMetric(metric);
    } catch (err) {
      persist = {
        ok: false,
        error: err && err.message ? err.message : 'persist_failed',
      };
    }

    // Logs: IDs, timings, scores only — never title/content
    log.info('Semantic shadow evaluation', {
      requestId,
      newsId,
      language,
      source,
      status,
      errorCode,
      exactScore: metric.exactScore,
      nearScore: metric.nearScore,
      semanticScore: metric.semanticScore,
      semanticCandidateId: metric.semanticCandidateId,
      latencyMs: metric.latencyMs,
      embedLatencyMs: metric.embedLatencyMs,
      vectorSearchLatencyMs: metric.vectorSearchLatencyMs,
      embeddingVersion: metric.embeddingVersion,
      modelId: metric.modelId,
      persisted: persist.ok === true,
    });

    return {
      executed: true,
      reason: status === 'ok' ? 'shadow_ok' : 'shadow_error',
      metric,
      persisted: persist.ok === true,
      persistId: persist.id || null,
    };
  }

  /**
   * Fire-and-forget. Never blocks / never throws to callers.
   * Does nothing when shadow flag is OFF.
   */
  function schedule(input = {}) {
    if (!isAiSemanticShadowEnabled(env)) {
      return { scheduled: false, reason: 'shadow_disabled' };
    }

    const run =
      typeof deps.scheduleFn === 'function'
        ? deps.scheduleFn
        : (fn) => {
            Promise.resolve()
              .then(fn)
              .catch(() => {});
          };

    run(() => evaluate(input));
    return { scheduled: true, reason: 'shadow_scheduled' };
  }

  return {
    evaluate,
    schedule,
    extractExactNearSnapshots,
    compareResults,
    isEnabled: () => isAiSemanticShadowEnabled(env),
  };
}

const defaultService = createSemanticShadowService();

module.exports = {
  createSemanticShadowService,
  extractExactNearSnapshots,
  compareResults,
  evaluate: defaultService.evaluate,
  schedule: defaultService.schedule,
};
