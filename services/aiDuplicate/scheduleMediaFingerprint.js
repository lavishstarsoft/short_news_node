'use strict';

/**
 * Fire-and-forget media fingerprint (pHash/dHash/OpenCLIP) + FAISS index.
 * Node persists results on News.mediaFingerprint. Never blocks publish.
 *
 * Guards:
 * - skip when fingerprint already ready for same media URL
 * - atomic pending claim to prevent duplicate concurrent jobs
 * - bounded in-flight + queue (prevents AI thundering herd)
 * - retry with backoff on transient HTTP failure
 */

const { createAiLogger } = require('./logger');
const { loadAiConfig } = require('./config');

const DEFAULT_MAX_IN_FLIGHT = 5;
const DEFAULT_MAX_QUEUE = 200;

function createMediaFingerprintScheduler(deps = {}) {
  const getConfig = deps.getConfig || loadAiConfig;
  const log =
    deps.log ||
    createAiLogger({
      logger: deps.logger,
      isEnabled: () => true,
    });
  const getNews = () => deps.News || require('../../models/News');
  const http = deps.http || require('axios');
  const maxInFlight = Math.max(
    1,
    parseInt(process.env.MEDIA_FINGERPRINT_MAX_IN_FLIGHT || '', 10) ||
      DEFAULT_MAX_IN_FLIGHT
  );
  const maxQueue = Math.max(
    1,
    parseInt(process.env.MEDIA_FINGERPRINT_MAX_QUEUE || '', 10) ||
      DEFAULT_MAX_QUEUE
  );

  let inFlight = 0;
  const waitQueue = [];

  function enqueue(fn) {
    const run = () => {
      inFlight += 1;
      Promise.resolve()
        .then(fn)
        .catch(() => {})
        .finally(() => {
          inFlight -= 1;
          if (waitQueue.length > 0) {
            const next = waitQueue.shift();
            next();
          }
        });
    };
    if (inFlight >= maxInFlight) {
      if (waitQueue.length >= maxQueue) {
        // Drop oldest to bound memory under upload storms
        waitQueue.shift();
        log.warn('media fingerprint queue overflow — dropped oldest job', {
          maxQueue,
        });
      }
      waitQueue.push(run);
      return;
    }
    run();
  }

  const scheduleFn =
    typeof deps.scheduleFn === 'function'
      ? deps.scheduleFn
      : (fn) => enqueue(fn);

  function primaryMediaUrl(news) {
    return (
      (news && (news.mediaUrl || news.thumbnailUrl)) ||
      (Array.isArray(news && news.imageUrls) && news.imageUrls[0]) ||
      ''
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function claimPending(newsId, mediaUrl) {
    const News = getNews();
    const staleBefore = new Date(Date.now() - 2 * 60 * 1000);
    return News.findOneAndUpdate(
      {
        _id: newsId,
        $or: [
          { 'mediaFingerprint.status': { $exists: false } },
          { 'mediaFingerprint.status': { $nin: ['pending'] } },
          { 'mediaFingerprint.computedAt': { $lte: staleBefore } },
          { 'mediaFingerprint.mediaUrl': { $ne: mediaUrl } },
        ],
      },
      {
        $set: {
          'mediaFingerprint.status': 'pending',
          'mediaFingerprint.mediaUrl': mediaUrl || null,
          'mediaFingerprint.computedAt': new Date(),
          'mediaFingerprint.lastError': null,
        },
      },
      { new: true }
    ).lean();
  }

  async function fingerprintAndPersist(news) {
    if (!news || news._id == null) {
      return { ok: false, reason: 'missing_news' };
    }
    const mediaUrl = news.mediaUrl || '';
    const thumbnailUrl = news.thumbnailUrl || '';
    const imageUrls = Array.isArray(news.imageUrls) ? news.imageUrls : [];
    if (!mediaUrl && !thumbnailUrl && imageUrls.length === 0) {
      return { ok: false, reason: 'no_media' };
    }

    const cfg = getConfig();
    if (!cfg.enabled || !cfg.apiKey || !cfg.baseUrl) {
      return { ok: false, reason: 'ai_disabled' };
    }

    const News = getNews();
    const existing = await News.findById(news._id)
      .select('mediaUrl thumbnailUrl imageUrls mediaType videoUrl mediaFingerprint')
      .lean();
    if (!existing) {
      return { ok: false, reason: 'news_missing' };
    }

    const currentUrl = primaryMediaUrl(existing);
    const fp = existing.mediaFingerprint || {};
    if (
      fp.status === 'ready' &&
      fp.mediaUrl === currentUrl &&
      ((Array.isArray(fp.clipEmbedding) && fp.clipEmbedding.length > 0) ||
        fp.phash)
    ) {
      return { ok: true, reason: 'unchanged' };
    }

    const claimed = await claimPending(news._id, currentUrl);
    if (!claimed) {
      return { ok: true, reason: 'in_progress' };
    }

    const payload = {
      media_url: existing.mediaUrl || mediaUrl || null,
      media_type: news.mediaType || existing.mediaType || null,
      image_urls: Array.isArray(existing.imageUrls)
        ? existing.imageUrls
        : imageUrls,
      thumbnail_url: existing.thumbnailUrl || thumbnailUrl || null,
      video_url: news.videoUrl || existing.videoUrl || null,
      news_id: String(news._id),
      media_id: `${String(news._id)}:${currentUrl || 'media'}`,
      index_vector: true,
    };

    let response;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        response = await http.post(
          `${cfg.baseUrl}/v1/media/fingerprint`,
          payload,
          {
            timeout: Math.max(cfg.timeoutMs || 1000, 20000),
            headers: {
              'Content-Type': 'application/json',
              'X-AI-Service-Key': cfg.apiKey,
            },
            validateStatus: () => true,
          }
        );
        if (response.status >= 200 && response.status < 300) {
          break;
        }
        const retryable =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        if (!retryable || attempt === maxAttempts) {
          break;
        }
        await sleep(250 * attempt);
      } catch (err) {
        if (attempt === maxAttempts) {
          log.warn('media fingerprint schedule error', {
            newsId: String(news._id),
            error: err && err.message ? err.message : String(err),
          });
          await News.updateOne(
            { _id: news._id },
            {
              $set: {
                'mediaFingerprint.status': 'failed',
                'mediaFingerprint.lastError': 'http_exception',
                'mediaFingerprint.computedAt': new Date(),
              },
            }
          );
          return { ok: false, reason: 'http_exception' };
        }
        await sleep(250 * attempt);
      }
    }

    if (!response || response.status < 200 || response.status >= 300) {
      log.warn('media fingerprint HTTP error', {
        newsId: String(news._id),
        status: response ? response.status : null,
      });
      await News.updateOne(
        { _id: news._id },
        {
          $set: {
            'mediaFingerprint.status': 'failed',
            'mediaFingerprint.lastError': `http_${response ? response.status : 'none'}`,
            'mediaFingerprint.computedAt': new Date(),
          },
        }
      );
      return { ok: false, reason: `http_${response ? response.status : 'none'}` };
    }

    const data = response.data || {};
    if (!data.success) {
      log.warn('media fingerprint failed', {
        newsId: String(news._id),
        error: data.error || 'unknown',
      });
      await News.updateOne(
        { _id: news._id },
        {
          $set: {
            'mediaFingerprint.status': 'failed',
            'mediaFingerprint.lastError': data.error || 'fingerprint_failed',
            'mediaFingerprint.computedAt': new Date(),
          },
        }
      );
      return { ok: false, reason: data.error || 'fingerprint_failed' };
    }

    await News.updateOne(
      { _id: news._id },
      {
        $set: {
          mediaFingerprint: {
            status: 'ready',
            sha256: data.sha256 || null,
            phash: data.phash || null,
            dhash: data.dhash || null,
            clipEmbedding: Array.isArray(data.clip_embedding)
              ? data.clip_embedding
              : null,
            clipEmbeddingVersion: data.clip_embedding_version || null,
            modelId: data.model_id || null,
            dimensions: data.dimensions || null,
            mediaUrl: data.media_url || currentUrl || null,
            indexed: data.indexed === true,
            lastError: null,
            computedAt: new Date(),
          },
        },
      }
    );

    log.debug('media fingerprint persisted', {
      newsId: String(news._id),
      indexed: data.indexed === true,
    });

    // Create-time detect often ran before fingerprints (or while download failed).
    // Refresh duplicateCheck so pending badges catch same-image posts.
    try {
      await refreshDuplicateCheckAfterFingerprint(news._id);
    } catch (err) {
      log.warn('media fingerprint duplicate refresh failed', {
        newsId: String(news._id),
        error: err && err.message ? err.message : String(err),
      });
    }

    return { ok: true, reason: 'persisted' };
  }

  async function refreshDuplicateCheckAfterFingerprint(newsId) {
    const News = getNews();
    const article = await News.findById(newsId)
      .select(
        'title content language mediaUrl mediaType imageUrls thumbnailUrl videoUrl duplicateCheck isActive'
      )
      .lean();
    if (!article) return;
    const dc = article.duplicateCheck || {};
    if (dc.isDuplicate === true) return;

    const { runDuplicateCheckGateway } = require('./runDuplicateCheckGateway');
    const { contentHash, duplicateCheck } = await runDuplicateCheckGateway(
      article,
      {
        excludeId: newsId,
        includePendingCorpus: true,
      }
    );
    await News.updateOne(
      { _id: newsId },
      { $set: { contentHash, duplicateCheck } }
    );
    log.info('duplicateCheck refreshed after media fingerprint', {
      newsId: String(newsId),
      isDuplicate: duplicateCheck && duplicateCheck.isDuplicate === true,
      isSuspicious: duplicateCheck && duplicateCheck.isSuspicious === true,
      score: duplicateCheck && duplicateCheck.score,
    });
  }

  function scheduleMediaFingerprint(news) {
    scheduleFn(async () => {
      try {
        await fingerprintAndPersist(news);
      } catch (err) {
        log.warn('media fingerprint schedule error', {
          newsId: news && news._id != null ? String(news._id) : null,
          error: err && err.message ? err.message : String(err),
        });
        try {
          if (news && news._id != null) {
            await getNews().updateOne(
              { _id: news._id, 'mediaFingerprint.status': 'pending' },
              {
                $set: {
                  'mediaFingerprint.status': 'failed',
                  'mediaFingerprint.lastError': 'unhandled_exception',
                  'mediaFingerprint.computedAt': new Date(),
                },
              }
            );
          }
        } catch (_) {
          /* ignore */
        }
      }
    });
    return {
      scheduled: true,
      inFlight,
      queued: waitQueue.length,
    };
  }

  return {
    fingerprintAndPersist,
    scheduleMediaFingerprint,
    _stats: () => ({ inFlight, queued: waitQueue.length, maxInFlight, maxQueue }),
  };
}

const defaultScheduler = createMediaFingerprintScheduler();

module.exports = {
  createMediaFingerprintScheduler,
  scheduleMediaFingerprint: defaultScheduler.scheduleMediaFingerprint,
};
