'use strict';

/**
 * Phase-4.1 — Background PENDING → embed → READY|FAILED worker.
 *
 * Updates NewsVector status transitions only (never News.duplicateCheck).
 * Does not change gateway / newsController / Reporter APIs.
 * Default OFF via AI_EMBED_WORKER_ENABLED.
 */

const C = require('./constants');
const { STATUS } = require('./statuses');
const { isAiEmbedWorkerEnabled } = require('./flags');
const { createNewsVectorPersistence } = require('./newsVectorPersistence');
const { createEmbedWorkerMetrics } = require('./embedWorkerMetrics');
const { createEmbedWorkerClaim, CLEAR_CLAIM } = require('./embedWorkerClaim');
const { loadAiConfig } = require('../config');
const { createAiLogger } = require('../logger');
const crypto = require('crypto');

function parseIntEnv(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function loadEmbedWorkerConfig(env = process.env) {
  return {
    enabled: isAiEmbedWorkerEnabled(env),
    maxAttempts: parseIntEnv(
      env.AI_EMBED_WORKER_MAX_ATTEMPTS,
      C.DEFAULT_EMBED_WORKER_MAX_ATTEMPTS
    ),
    baseDelayMs: parseIntEnv(
      env.AI_EMBED_WORKER_BASE_DELAY_MS,
      C.DEFAULT_EMBED_WORKER_BASE_DELAY_MS
    ),
    maxDelayMs: parseIntEnv(
      env.AI_EMBED_WORKER_MAX_DELAY_MS,
      C.DEFAULT_EMBED_WORKER_MAX_DELAY_MS
    ),
    batchSize: parseIntEnv(
      env.AI_EMBED_WORKER_BATCH_SIZE,
      C.DEFAULT_EMBED_WORKER_BATCH_SIZE
    ),
    pollMs: parseIntEnv(
      env.AI_EMBED_WORKER_POLL_MS,
      C.DEFAULT_EMBED_WORKER_POLL_MS
    ),
    embedTimeoutMs: parseIntEnv(
      env.AI_EMBED_WORKER_EMBED_TIMEOUT_MS,
      C.DEFAULT_EMBED_WORKER_EMBED_TIMEOUT_MS
    ),
    leaseMs: parseIntEnv(
      env.AI_EMBED_WORKER_LEASE_MS,
      C.DEFAULT_EMBED_WORKER_LEASE_MS
    ),
  };
}

/**
 * Exponential backoff: base * 2^(attempt-1), capped.
 * attempt is 1-based (first failure → attempt 1 → base delay).
 */
function computeBackoffMs(attempt, baseDelayMs, maxDelayMs) {
  const a = Math.max(1, attempt);
  const delay = baseDelayMs * 2 ** (a - 1);
  return Math.min(maxDelayMs, delay);
}

function createDefaultEmbedFn(deps = {}) {
  return async function embedText(payload = {}) {
    const env = deps.env || process.env;
    const cfg = loadAiConfig(env);
    const http = deps.http || require('axios');
    const timeoutMs =
      deps.timeoutMs ||
      parseIntEnv(
        env.AI_EMBED_WORKER_EMBED_TIMEOUT_MS,
        C.DEFAULT_EMBED_WORKER_EMBED_TIMEOUT_MS
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
        embedResponse: {
          success: true,
          implemented: true,
          phase: data.phase || '3B.2',
          modelId: data.modelId || C.DEFAULT_MODEL_ID,
          embeddingVersion: data.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION,
          dimensions: data.dimensions || C.EMBEDDING_DIMENSIONS,
          embedding: data.embedding,
          metadata: data.metadata || {},
        },
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

function createEmbedPendingWorker(deps = {}) {
  const env = deps.env || process.env;
  const config = deps.config || loadEmbedWorkerConfig(env);
  const now = deps.now || (() => Date.now());
  const metrics = deps.metrics || createEmbedWorkerMetrics({ now });
  const persistence =
    deps.persistence ||
    createNewsVectorPersistence({ NewsVector: deps.NewsVector });
  const getNewsVector = () =>
    deps.NewsVector || require('../../../models/NewsVector');
  const getNews = () => deps.News || require('../../../models/News');
  const workerId =
    deps.workerId ||
    `embed-worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const claimApi =
    deps.claim ||
    createEmbedWorkerClaim({
      NewsVector: deps.NewsVector,
      now,
      leaseMs: config.leaseMs,
    });
  const embedText =
    deps.embedText ||
    createDefaultEmbedFn({
      env,
      http: deps.http,
      timeoutMs: config.embedTimeoutMs,
    });
  const log =
    deps.log ||
    createAiLogger({
      logger: deps.logger,
      isEnabled: () => isAiEmbedWorkerEnabled(env),
    });

  async function scheduleRetry(doc, attempts, errorCode) {
    const NewsVector = getNewsVector();
    const delayMs = computeBackoffMs(
      attempts,
      config.baseDelayMs,
      config.maxDelayMs
    );
    const nextEmbedAt = new Date(now() + delayMs);
    await NewsVector.findOneAndUpdate(
      {
        newsId: doc.newsId,
        embeddingVersion: doc.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION,
        modality: C.MODALITY_TEXT,
        status: STATUS.PENDING,
      },
      {
        $set: {
          embedAttempts: attempts,
          nextEmbedAt,
          lastEmbedAttemptAt: new Date(now()),
          lastError: String(errorCode || 'embed_failed').slice(0, 2000),
          ...CLEAR_CLAIM,
        },
      }
    );
    return { delayMs, nextEmbedAt };
  }

  /**
   * Process a single claimed PENDING (or READY idempotent) vector doc.
   * Only claimed PENDING items should be passed for embed work.
   */
  async function processOne(doc) {
    const started = now();
    const newsId = doc.newsId;
    const embeddingVersion =
      doc.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION;
    const contentHash = String(doc.contentHash || '');

    // Idempotent: already READY with embedding for this hash
    if (
      doc.status === STATUS.READY &&
      Array.isArray(doc.embedding) &&
      doc.embedding.length === C.EMBEDDING_DIMENSIONS
    ) {
      metrics.recordSkipped('already_ready');
      return { outcome: 'skipped_unchanged', newsId: String(newsId) };
    }

    if (doc.status !== STATUS.PENDING) {
      metrics.recordSkipped('not_pending');
      return { outcome: 'skipped_not_pending', newsId: String(newsId) };
    }

    const News = getNews();
    let news = null;
    try {
      const q = News.findById(newsId).select(
        'title content contentHash language isActive publishedAt'
      );
      news = q && typeof q.lean === 'function' ? await q.lean() : await q;
    } catch (_) {
      news = null;
    }

    if (!news) {
      await persistence.persistEmbedFailure({
        newsId,
        contentHash,
        embeddingVersion,
        language: doc.language,
        error: 'news_not_found',
      });
      metrics.recordFailure('news_not_found', now() - started);
      return { outcome: 'failed', error: 'news_not_found' };
    }

    const newsHash = news.contentHash != null ? String(news.contentHash) : '';

    // Respect contentHash — if article changed, refresh PENDING and skip this embed
    if (newsHash && contentHash && newsHash !== contentHash) {
      await persistence.ensurePending({
        newsId,
        contentHash: newsHash,
        language: news.language || doc.language,
        isActive: news.isActive === true,
        publishedAt: news.publishedAt || null,
        embeddingVersion,
      });
      metrics.recordSkipped('content_hash_mismatch');
      log.info('Embed worker skipped hash mismatch', {
        newsId: String(newsId),
        embeddingVersion,
      });
      return { outcome: 'skipped_hash_mismatch' };
    }

    // Unchanged READY path via News hash + existing READY (race)
    if (
      newsHash &&
      contentHash === newsHash &&
      doc.status === STATUS.READY
    ) {
      metrics.recordSkipped('unchanged_content');
      return { outcome: 'skipped_unchanged' };
    }

    const embedResult = await embedText({
      title: news.title || '',
      content: news.content || '',
      language: (news.language || doc.language || 'te').toLowerCase(),
      requestId: `embed-worker-${String(newsId)}`,
    });

    const embedLatencyMs =
      typeof embedResult.latencyMs === 'number'
        ? embedResult.latencyMs
        : null;
    if (embedLatencyMs != null) {
      metrics.recordEmbedLatency(embedLatencyMs);
    }

    const latencyMs =
      typeof embedResult.latencyMs === 'number'
        ? embedResult.latencyMs
        : now() - started;

    if (!embedResult.ok) {
      const attempts = (doc.embedAttempts || 0) + 1;
      const errorCode = embedResult.error || 'embed_failed';

      if (attempts >= config.maxAttempts) {
        log.warn('Embed worker FAILED after retries', {
          newsId: String(newsId),
          attempts,
          error: errorCode,
          latencyMs,
        });
        await persistence.persistEmbedFailure({
          newsId,
          contentHash: newsHash || contentHash,
          embeddingVersion,
          language: news.language || doc.language,
          error: `${errorCode}; attempts=${attempts}`,
        });
        metrics.recordFailure(errorCode, latencyMs);
        return { outcome: 'failed', attempts, error: errorCode };
      }

      const retry = await scheduleRetry(doc, attempts, errorCode);
      metrics.recordRetry(errorCode);
      log.warn('Embed worker retry scheduled', {
        newsId: String(newsId),
        attempts,
        delayMs: retry.delayMs,
        error: errorCode,
      });
      return {
        outcome: 'retry',
        attempts,
        delayMs: retry.delayMs,
        error: errorCode,
      };
    }

    // Re-check hash before write (idempotent / avoid stale READY)
    const NewsVector = getNewsVector();
    const freshQ = NewsVector.findOne({
      newsId,
      embeddingVersion,
      modality: C.MODALITY_TEXT,
    });
    const fresh =
      freshQ && typeof freshQ.lean === 'function'
        ? await freshQ.lean()
        : await freshQ;

    if (fresh && fresh.status === STATUS.READY && fresh.contentHash === (newsHash || contentHash)) {
      await claimApi.releaseClaim(doc);
      metrics.recordSkipped('already_ready_race');
      return { outcome: 'skipped_unchanged' };
    }

    if (
      fresh &&
      fresh.contentHash &&
      newsHash &&
      String(fresh.contentHash) !== newsHash
    ) {
      await claimApi.releaseClaim(doc);
      metrics.recordSkipped('content_hash_changed_midflight');
      return { outcome: 'skipped_hash_mismatch' };
    }

    const persisted = await persistence.persistEmbedSuccess({
      newsId,
      contentHash: newsHash || contentHash,
      language: news.language || doc.language,
      isActive: news.isActive === true,
      publishedAt: news.publishedAt || null,
      embedResponse: embedResult.embedResponse,
    });

    if (!persisted.persisted) {
      const attempts = (doc.embedAttempts || 0) + 1;
      if (attempts >= config.maxAttempts) {
        await persistence.persistEmbedFailure({
          newsId,
          contentHash: newsHash || contentHash,
          embeddingVersion,
          language: news.language || doc.language,
          error: persisted.error || 'persist_validation_failed',
        });
        metrics.recordFailure(persisted.error || 'persist_failed', latencyMs);
        return { outcome: 'failed', error: persisted.error };
      }
      await scheduleRetry(doc, attempts, persisted.error || 'persist_failed');
      metrics.recordRetry(persisted.error || 'persist_failed');
      return { outcome: 'retry', error: persisted.error };
    }

    metrics.recordSuccess(latencyMs);
    log.info('Embed worker READY', {
      newsId: String(newsId),
      embeddingVersion,
      latencyMs,
      status: STATUS.READY,
      workerId,
    });
    return { outcome: 'success', latencyMs, status: STATUS.READY };
  }

  async function processBatch(options = {}) {
    if (!isAiEmbedWorkerEnabled(env) && options.force !== true) {
      return {
        ran: false,
        reason: 'worker_disabled',
        results: [],
        metrics: metrics.snapshot(),
      };
    }

    metrics.recordBatch();
    const batchSize = options.batchSize || config.batchSize;
    const claimStarted = now();
    const claimResult = await claimApi.claimBatch(workerId, batchSize);
    const claimLatencyMs =
      typeof claimResult.claimLatencyMs === 'number'
        ? claimResult.claimLatencyMs
        : now() - claimStarted;
    metrics.recordClaimLatency(claimLatencyMs);

    const claimed = Array.isArray(claimResult)
      ? claimResult
      : claimResult.docs || [];
    const reclaimCount = claimResult.reclaimCount || 0;

    metrics.recordClaimed(claimed.length);
    if (reclaimCount > 0) {
      metrics.recordReclaim(reclaimCount);
    }

    const results = [];

    for (const doc of claimed) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await processOne(doc);
        results.push({ ...r, claimedBy: workerId });
      } catch (err) {
        metrics.recordFailure('worker_exception');
        try {
          // eslint-disable-next-line no-await-in-loop
          await claimApi.releaseClaim(doc);
        } catch (_) {
          /* lease expiry will unlock */
        }
        log.warn('Embed worker exception', {
          newsId: doc && doc.newsId != null ? String(doc.newsId) : null,
          workerId,
          error: err && err.message ? err.message : 'unknown',
        });
        results.push({ outcome: 'failed', error: 'worker_exception' });
      }
    }

    return {
      ran: true,
      processed: results.length,
      claimed: claimed.length,
      reclaims: reclaimCount,
      workerId,
      results,
      metrics: metrics.snapshot(),
    };
  }

  return {
    processOne,
    processBatch,
    claimNext: () => claimApi.claimNext(workerId),
    claimBatch: (limit) => claimApi.claimBatch(workerId, limit),
    releaseClaim: claimApi.releaseClaim,
    computeBackoffMs,
    getMetrics: () => metrics.snapshot(),
    getConfig: () => ({ ...config }),
    getWorkerId: () => workerId,
    metrics,
  };
}

/**
 * Start polling loop when AI_EMBED_WORKER_ENABLED=true.
 * Safe no-op when flag OFF.
 */
function maybeStartEmbedPendingWorker(deps = {}) {
  const env = deps.env || process.env;
  const config = loadEmbedWorkerConfig(env);

  if (!config.enabled) {
    return { started: false, reason: 'worker_disabled' };
  }

  if (maybeStartEmbedPendingWorker._timer) {
    return { started: true, reason: 'already_running' };
  }

  const worker =
    deps.worker ||
    createEmbedPendingWorker({
      env,
      config,
      log: deps.log,
      News: deps.News,
      NewsVector: deps.NewsVector,
      embedText: deps.embedText,
      http: deps.http,
    });

  let tickRunning = false;
  const timer = setInterval(() => {
    if (tickRunning) return;
    tickRunning = true;
    Promise.resolve()
      .then(() => worker.processBatch())
      .catch(() => {})
      .finally(() => {
        tickRunning = false;
      });
  }, config.pollMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  maybeStartEmbedPendingWorker._timer = timer;
  maybeStartEmbedPendingWorker._worker = worker;

  return { started: true, reason: 'started', pollMs: config.pollMs, worker };
}

function stopEmbedPendingWorker() {
  if (maybeStartEmbedPendingWorker._timer) {
    clearInterval(maybeStartEmbedPendingWorker._timer);
    maybeStartEmbedPendingWorker._timer = null;
    maybeStartEmbedPendingWorker._worker = null;
  }
}

module.exports = {
  createEmbedPendingWorker,
  loadEmbedWorkerConfig,
  computeBackoffMs,
  maybeStartEmbedPendingWorker,
  stopEmbedPendingWorker,
};
