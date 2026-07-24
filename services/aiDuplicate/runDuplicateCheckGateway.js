'use strict';

/**
 * runDuplicateCheckGateway — Phase-3A safe Node ↔ AI integration.
 *
 * - AI_DUPLICATE_ENABLED=false → identical to runDuplicateCheck
 * - AI on → candidates + /v1/detect → map to legacy shape
 * - Any AI failure / invalid schema / circuit open → runDuplicateCheck
 * - Never writes DB; never throws AI errors to HTTP callers
 * - Phase-3B.5: optional fire-and-forget semantic shadow (metrics only).
 *   Shadow never mutates duplicateCheck / contentHash returned to callers.
 */

const crypto = require('crypto');
const { runDuplicateCheck } = require('../duplicateCheckService');
const { generateContentHash } = require('../../utils/similarityDetector');
const { isAiDuplicateEnabled } = require('./featureFlag');
const { loadAiConfig } = require('./config');
const { createAiLogger } = require('./logger');
const { createHttpClient } = require('./client');
const { createCircuitBreaker } = require('./circuitBreaker');
const { validateAiDetectResponse } = require('./validateAiResponse');
const { mapAiResponseToDuplicateCheck } = require('./mapAiToLegacy');
const { enrichSimilarArticlesFromDb } = require('./enrichSimilarArticles');
const { fetchAiCandidates } = require('./fetchCandidates');
const {
  createSemanticShadowService,
} = require('./semantic/semanticShadowService');

const sharedBreaker = createCircuitBreaker({
  failureThreshold: 5,
  resetTimeoutMs: 30000,
});

function createGateway(deps = {}) {
  const env = deps.env || process.env;
  const runLegacy = deps.runDuplicateCheck || runDuplicateCheck;
  const fetchCandidates = deps.fetchAiCandidates || fetchAiCandidates;
  const hashFn = deps.generateContentHash || generateContentHash;
  const breaker = deps.circuitBreaker || sharedBreaker;
  const now = deps.now || (() => Date.now());
  const uuid = deps.uuid || (() => crypto.randomUUID());

  const getConfig = () => loadAiConfig(env);
  const log = deps.log || createAiLogger({
    logger: deps.logger,
    isEnabled: () => isAiDuplicateEnabled(env),
  });

  const httpClient =
    deps.httpClient ||
    createHttpClient({
      http: deps.http,
      getConfig,
      log,
    });

  const shadow =
    deps.semanticShadow ||
    createSemanticShadowService({
      env,
      log,
      http: deps.http,
      SemanticShadowMetric: deps.SemanticShadowMetric,
      collection: deps.newsVectorsCollection,
      NewsVector: deps.NewsVector,
      embedText: deps.shadowEmbedText,
      vectorSearch: deps.shadowVectorSearch,
      scheduleFn: deps.shadowScheduleFn,
    });

  /**
   * Phase-3B.5 — metrics-only side effect. Never mutates `result`.
   * Title/content passed for embed compute only; never logged/stored by shadow.
   */
  function maybeScheduleShadow(result, ctx) {
    try {
      shadow.schedule({
        requestId: ctx.requestId,
        newsId: ctx.newsId,
        language: ctx.language,
        title: ctx.title,
        content: ctx.content,
        duplicateCheck: result && result.duplicateCheck,
        aiExact: ctx.aiExact || null,
        aiNear: ctx.aiNear || null,
        source: ctx.source || 'legacy',
      });
    } catch (_) {
      // Shadow must never affect gateway output / control flow
    }
    return result;
  }

  async function runDuplicateCheckGateway(article, options = {}) {
    const title = (article && article.title) || '';
    const content = (article && article.content) || '';
    const language = ((article && article.language) || 'te').toLowerCase();
    const excludeId = options.excludeId || null;
    const includePendingCorpus = options.includePendingCorpus !== false;
    const requestId = uuid();

    const imageUrls = Array.isArray(article && article.imageUrls)
      ? article.imageUrls.filter(Boolean)
      : Array.isArray(article && article.image_urls)
        ? article.image_urls.filter(Boolean)
        : [];
    const mediaUrl = (article && (article.mediaUrl || article.media_url)) || '';
    const mediaType = (article && (article.mediaType || article.media_type)) || '';
    const thumbnailUrl =
      (article && (article.thumbnailUrl || article.thumbnail_url)) || '';
    const videoUrl = (article && (article.videoUrl || article.video_url)) || '';
    const queryImageUrls =
      imageUrls.length > 0
        ? imageUrls
        : mediaUrl && mediaType === 'image'
          ? [mediaUrl]
          : mediaUrl
            ? [mediaUrl]
            : [];

    const shadowBase = {
      requestId,
      newsId: excludeId ? String(excludeId) : null,
      language,
      title,
      content,
    };

    // Permanent fallback path — identical to today's production behavior
    const fallback = async () => {
      const result = await runLegacy(
        { title, content, language },
        { excludeId, includePendingCorpus }
      );
      return maybeScheduleShadow(result, {
        ...shadowBase,
        source: 'legacy',
      });
    };

    if (!isAiDuplicateEnabled(env)) {
      return fallback();
    }

    const started = now();

    if (!breaker.allowRequest()) {
      log.warn('AI circuit open — fallback', {
        requestId,
        circuit: breaker.snapshot(),
      });
      const result = await fallback();
      log.info('AI duplicate gateway', {
        requestId,
        latencyMs: now() - started,
        fallbackUsed: true,
        reason: 'circuit_open',
      });
      return result;
    }

    try {
      const candidates = await fetchCandidates(language, excludeId, {
        News: deps.News,
      });

      const aiResult = await httpClient.detectDuplicate({
        title,
        content,
        language,
        newsId: excludeId ? String(excludeId) : null,
        imageUrls: queryImageUrls,
        mediaUrl: mediaUrl || null,
        mediaType: mediaType || null,
        thumbnailUrl: thumbnailUrl || null,
        videoUrl: videoUrl || null,
        candidates,
        requestId,
      });

      const latencyMs = now() - started;

      if (!aiResult.ok) {
        breaker.recordFailure();
        log.warn('AI detect failed — fallback', {
          requestId,
          latencyMs,
          fallbackUsed: true,
          reason: aiResult.source,
          error: aiResult.error || null,
        });
        return fallback();
      }

      const validated = validateAiDetectResponse(aiResult.data);
      if (!validated.ok) {
        breaker.recordFailure();
        log.warn('AI invalid response — fallback', {
          requestId,
          latencyMs,
          fallbackUsed: true,
          reason: 'invalid_response',
          error: validated.error,
        });
        return fallback();
      }

      breaker.recordSuccess();
      let duplicateCheck = mapAiResponseToDuplicateCheck(
        validated.data,
        candidates
      );
      try {
        const enriched = await enrichSimilarArticlesFromDb(
          duplicateCheck.similarArticles || [],
          { News: deps.News }
        );
        const selfId = excludeId != null ? String(excludeId) : null;
        const filtered = selfId
          ? enriched.filter((row) => {
              const aid = row && row.articleId != null ? String(row.articleId) : '';
              if (!aid) return true;
              if (aid === selfId) return false;
              if (aid.startsWith(`${selfId}:`)) return false;
              return true;
            })
          : enriched;
        const clearedSelf =
          filtered.length === 0 &&
          (duplicateCheck.isDuplicate || duplicateCheck.isSuspicious);
        duplicateCheck = {
          ...duplicateCheck,
          similarArticles: filtered,
          matchCount: filtered.length,
          ...(clearedSelf
            ? {
                isDuplicate: false,
                isSuspicious: false,
                score: 0,
                matchSource: null,
                reasonLabel: null,
                reasonMessage: null,
              }
            : {}),
        };
      } catch (enrichErr) {
        log.warn('similarArticles enrich failed', {
          requestId,
          error:
            enrichErr && enrichErr.message
              ? enrichErr.message
              : 'unknown',
        });
      }
      // Keep Node MD5 contentHash for compatibility with legacy exact-hash index
      const contentHash = hashFn(title, content);

      log.info('AI duplicate gateway', {
        requestId,
        latencyMs,
        fallbackUsed: false,
        reason: 'ai_success',
        candidatesScored: validated.data.candidates_scored,
        overallScore: duplicateCheck.score,
      });

      return maybeScheduleShadow(
        { contentHash, duplicateCheck },
        {
          ...shadowBase,
          source: 'ai',
          aiExact: validated.data.exact || null,
          aiNear: validated.data.near || null,
        }
      );
    } catch (err) {
      breaker.recordFailure();
      log.warn('AI gateway exception — fallback', {
        requestId,
        latencyMs: now() - started,
        fallbackUsed: true,
        reason: 'exception',
        error: err && err.message ? err.message : 'unknown',
      });
      return fallback();
    }
  }

  return {
    runDuplicateCheckGateway,
    circuitBreaker: breaker,
  };
}

const defaultGateway = createGateway();

module.exports = {
  runDuplicateCheckGateway: defaultGateway.runDuplicateCheckGateway,
  createGateway,
  sharedBreaker,
};
