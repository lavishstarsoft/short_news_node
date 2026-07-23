'use strict';

/**
 * Phase-4.2 — Fire-and-forget PENDING enqueue for news_vectors.
 *
 * Feeds embedPendingWorker. Never embeds synchronously.
 * Never mutates duplicateCheck / gateway responses.
 * Failures are logged only — callers must not await for publish correctness.
 */

const C = require('./constants');
const { createNewsVectorPersistence } = require('./newsVectorPersistence');
const { createAiLogger } = require('../logger');

function createNewsVectorPendingScheduler(deps = {}) {
  const persistence =
    deps.persistence ||
    createNewsVectorPersistence({ NewsVector: deps.NewsVector });
  const log =
    deps.log ||
    createAiLogger({
      logger: deps.logger,
      isEnabled: () => true,
    });

  const scheduleFn =
    typeof deps.scheduleFn === 'function'
      ? deps.scheduleFn
      : (fn) => {
          Promise.resolve()
            .then(fn)
            .catch(() => {});
        };

  async function enqueueCreate(news) {
    if (!news || news._id == null) {
      return { ok: false, reason: 'missing_news' };
    }
    const contentHash = news.contentHash != null ? String(news.contentHash) : '';
    if (!contentHash) {
      return { ok: false, reason: 'missing_content_hash' };
    }

    await persistence.ensurePending({
      newsId: news._id,
      contentHash,
      language: news.language || 'te',
      isActive: news.isActive === true,
      publishedAt: news.publishedAt || null,
      embeddingVersion: C.DEFAULT_EMBEDDING_VERSION,
      modelId: C.DEFAULT_MODEL_ID,
    });

    return { ok: true, reason: 'pending_ensured', status: 'PENDING' };
  }

  async function enqueueUpdate(input = {}) {
    const news = input.news;
    if (!news || news._id == null) {
      return { ok: false, reason: 'missing_news' };
    }

    const nextContentHash =
      news.contentHash != null ? String(news.contentHash) : '';
    if (!nextContentHash) {
      return { ok: false, reason: 'missing_content_hash' };
    }

    const previousContentHash =
      input.previousContentHash != null
        ? String(input.previousContentHash)
        : null;

    // Unchanged contentHash → do nothing
    if (
      previousContentHash != null &&
      previousContentHash === nextContentHash
    ) {
      return { ok: true, reason: 'unchanged', changed: false };
    }

    // Changed (or first hash) → STALE then PENDING via existing persistence
    const result = await persistence.markStaleAndPrepareReembed({
      newsId: news._id,
      previousContentHash,
      nextContentHash,
      language: news.language || 'te',
      title: news.title || '',
      content: news.content || '',
      isActive: news.isActive === true,
      publishedAt: news.publishedAt || null,
      embeddingVersion: C.DEFAULT_EMBEDDING_VERSION,
    });

    if (!result.changed) {
      // No prior vector + same hash path, or plan said unchanged — still ensure PENDING once
      if (previousContentHash == null) {
        await persistence.ensurePending({
          newsId: news._id,
          contentHash: nextContentHash,
          language: news.language || 'te',
          isActive: news.isActive === true,
          publishedAt: news.publishedAt || null,
        });
        return { ok: true, reason: 'pending_ensured', changed: true };
      }
      return { ok: true, reason: 'unchanged', changed: false };
    }

    return {
      ok: true,
      reason: 'stale_then_pending',
      changed: true,
      staleUpdated: Boolean(result.staleResult && result.staleResult.updated),
    };
  }

  /**
   * Non-blocking: never throws to HTTP handlers.
   */
  function schedulePendingAfterCreate(news) {
    scheduleFn(async () => {
      try {
        const result = await enqueueCreate(news);
        if (!result.ok) {
          log.warn('NewsVector PENDING enqueue (create) skipped', {
            newsId: news && news._id != null ? String(news._id) : null,
            reason: result.reason,
          });
        } else {
          log.info('NewsVector PENDING enqueue (create)', {
            newsId: String(news._id),
            reason: result.reason,
          });
        }
      } catch (err) {
        log.warn('NewsVector PENDING enqueue (create) failed', {
          newsId: news && news._id != null ? String(news._id) : null,
          error: err && err.message ? err.message : 'unknown',
        });
      }
    });
    return { scheduled: true };
  }

  function schedulePendingAfterUpdate(input = {}) {
    scheduleFn(async () => {
      try {
        const result = await enqueueUpdate(input);
        if (!result.ok) {
          log.warn('NewsVector PENDING enqueue (update) skipped', {
            newsId:
              input.news && input.news._id != null
                ? String(input.news._id)
                : null,
            reason: result.reason,
          });
        } else {
          log.info('NewsVector PENDING enqueue (update)', {
            newsId: String(input.news._id),
            reason: result.reason,
            changed: result.changed === true,
          });
        }
      } catch (err) {
        log.warn('NewsVector PENDING enqueue (update) failed', {
          newsId:
            input.news && input.news._id != null
              ? String(input.news._id)
              : null,
          error: err && err.message ? err.message : 'unknown',
        });
      }
    });
    return { scheduled: true };
  }

  return {
    enqueueCreate,
    enqueueUpdate,
    schedulePendingAfterCreate,
    schedulePendingAfterUpdate,
  };
}

const defaultScheduler = createNewsVectorPendingScheduler();

module.exports = {
  createNewsVectorPendingScheduler,
  schedulePendingAfterCreate: defaultScheduler.schedulePendingAfterCreate,
  schedulePendingAfterUpdate: defaultScheduler.schedulePendingAfterUpdate,
  enqueueCreate: defaultScheduler.enqueueCreate,
  enqueueUpdate: defaultScheduler.enqueueUpdate,
};
