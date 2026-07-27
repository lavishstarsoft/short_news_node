'use strict';

/**
 * Fire-and-forget AI verification for Sub Editor articles.
 *
 * Called once after news.save() in createNews — same pattern as
 * schedulePendingAfterCreate() and scheduleMediaFingerprint().
 *
 * - Never blocks the HTTP response.
 * - Calls runDuplicateCheckGateway() in background.
 * - On clean result  → sets isActive:true, aiStatus:'verified', emits news_published.
 * - On duplicate      → sets aiStatus:'review_required', keeps isActive:false.
 * - On failure        → retries 3× with backoff, then aiStatus:'failed'.
 */

const { runDuplicateCheckGateway } = require('./runDuplicateCheckGateway');
const { normalizeDuplicateCheck } = require('../duplicateCheckService');
const { clearCache } = require('../../middleware/cache');
const { createAiLogger } = require('./logger');

const logger = createAiLogger({ isEnabled: () => true });

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Core verification logic — retries up to MAX_RETRIES on AI failure.
 */
async function verifyArticle(news) {
  const News = require('../../models/News');
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await runDuplicateCheckGateway(
        {
          title: news.title,
          content: news.content,
          language: news.language,
          mediaUrl: news.mediaUrl,
          mediaType: news.mediaType,
          imageUrls: news.imageUrls,
          thumbnailUrl: news.thumbnailUrl,
          videoUrl: news.videoUrl,
        },
        { includePendingCorpus: true }
      );

      const duplicateCheck = normalizeDuplicateCheck(
        result.duplicateCheck || result
      );
      const isDuplicate =
        duplicateCheck.isDuplicate === true ||
        duplicateCheck.isSuspicious === true;

      if (isDuplicate) {
        // Duplicate suspected — keep Pending for human review
        const updateRes = await News.updateOne(
          { _id: news._id, contentHash: news.contentHash },
          {
            $set: {
              aiStatus: 'review_required',
              'duplicateCheck.isDuplicate': duplicateCheck.isDuplicate,
              'duplicateCheck.isSuspicious': duplicateCheck.isSuspicious,
              'duplicateCheck.score': duplicateCheck.score,
              'duplicateCheck.matchCount': duplicateCheck.matchCount,
              'duplicateCheck.checkedAt': new Date(),
              'duplicateCheck.matchSource': duplicateCheck.matchSource,
              'duplicateCheck.reasonLabel': duplicateCheck.reasonLabel,
              'duplicateCheck.reasonMessage': duplicateCheck.reasonMessage,
              'duplicateCheck.similarArticles':
                duplicateCheck.similarArticles || [],
              contentHash: result.contentHash || news.contentHash,
            },
          }
        );
        if (updateRes.matchedCount === 0) {
        logger.info(`discarded stale result (hash changed) newsId=${news._id}`);
          return { outcome: 'skipped_hash_mismatch' };
        }

        logger.info(`review_required newsId=${news._id} score=${duplicateCheck.score}`);
        return { outcome: 'review_required', score: duplicateCheck.score, duplicateCheck: duplicateCheck };
      }

      // Clean — auto-publish
      const updateRes = await News.updateOne(
        { _id: news._id, contentHash: news.contentHash },
        {
          $set: {
            aiStatus: 'verified',
            aiVerifiedAt: new Date(),
            isActive: true,
            'duplicateCheck.isDuplicate': false,
            'duplicateCheck.isSuspicious': false,
            'duplicateCheck.score': duplicateCheck.score || 0,
            'duplicateCheck.matchCount': duplicateCheck.matchCount || 0,
            'duplicateCheck.checkedAt': new Date(),
            contentHash: result.contentHash || news.contentHash,
          },
        }
      );

      // Clear public API cache so the article appears in feeds
      try {
        await clearCache('cache:/api/public/news*');
        await clearCache('cache:/api/public/locations*');
      } catch (_) {
        /* non-critical */
      }

      if (updateRes.matchedCount === 0) {
        logger.info(`discarded stale result (hash changed) newsId=${news._id}`);
        return { outcome: 'skipped_hash_mismatch' };
      }

      logger.info(`verified newsId=${news._id} → Active`);
      return { outcome: 'verified' };
    } catch (err) {
      lastError = err;
      console.warn(
        `[AI-Verify] attempt ${attempt}/${MAX_RETRIES} failed newsId=${news._id}:`,
        err.message
      );
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt - 1));
      }
    }
  }

  // All retries exhausted — mark failed
  try {
    const News = require('../../models/News');
    await News.updateOne(
      { _id: news._id, contentHash: news.contentHash },
      {
        $set: {
          aiStatus: 'failed',
        },
      }
    );
  } catch (_) {
    /* best-effort */
  }
  console.error(
    `[AI-Verify] FAILED after ${MAX_RETRIES} retries newsId=${news._id}:`,
    lastError && lastError.message
  );
  return { outcome: 'failed', error: lastError && lastError.message };
}

/**
 * Fire-and-forget scheduler — same pattern as schedulePendingAfterCreate.
 * Optionally emits news_published WebSocket event on auto-publish.
 */
function scheduleAiVerification(news, io) {
  Promise.resolve()
    .then(async () => {
      const result = await verifyArticle(news);

      // Notify the specific Sub Editor who owns this article about the AI result
      if (io) {
        try {
          const payload = {
            id: news._id,
            title: news.title,
            status: result.outcome, // 'verified', 'review_required', 'failed'
            timestamp: Date.now()
          };

          if (result.outcome === 'review_required' && result.duplicateCheck) {
            const dc = result.duplicateCheck;
            const topMatch = (dc.similarArticles && dc.similarArticles.length > 0) ? dc.similarArticles[0] : {};
            payload.duplicateSummary = {
              similarity: dc.score,
              reasonLabel: dc.reasonLabel,
              reasonMessage: dc.reasonMessage,
              similarArticles: dc.similarArticles || []
            };
          }

          io.to(`reporter:${news.authorId}`).emit('ai_status_updated', payload);

          // Also notify admin dashboards (Pending News) via the existing workflow
          // channel so the specific card shows the duplicate result without a refresh.
          if (result.outcome === 'review_required' && result.duplicateCheck) {
            const dc = result.duplicateCheck;
            const { emitWorkflowToAdmins } = require('../realtime/workflowEmit');
            emitWorkflowToAdmins(io, {
              id: news._id,
              status: 'review_required',
              duplicateCheck: {
                isDuplicate: dc.isDuplicate,
                isSuspicious: dc.isSuspicious,
                score: dc.score,
                matchCount: dc.matchCount,
                matchSource: dc.matchSource,
                reasonLabel: dc.reasonLabel,
                reasonMessage: dc.reasonMessage,
                similarArticles: dc.similarArticles || []
              }
            });
          }
        } catch (_) {
          /* ignore emit error */
        }
      }

      // Emit existing news_published event on auto-publish
      if (result.outcome === 'verified' && io) {
        try {
          const { emitPublished } = require('../realtime/workflowEmit');
          emitPublished(io, {
            id: news._id,
            title: news.title,
            content: news.content,
            category: news.category,
            location: news.location,
            publishedAt: news.publishedAt,
            author: news.author,
            authorId: news.authorId,
            mediaType: news.mediaType,
            mediaUrl: news.mediaUrl,
            thumbnailUrl: news.thumbnailUrl,
            imageUrl: news.imageUrl || news.mediaUrl,
            imageUrls: news.imageUrls || [],
            language: news.language,
          });
        } catch (_) {
          /* WebSocket emit is non-critical */
        }
      }
    })
    .catch((err) => {
      console.error(
        '[AI-Verify] unhandled error newsId=',
        news && news._id,
        err
      );
    });
}

/**
 * Startup sweep to recover articles that were verifying when the process exited.
 */
function recoverStuckVerifications(io) {
  Promise.resolve()
    .then(async () => {
      const News = require('../../models/News');
      const stuckArticles = await News.find({
        aiStatus: 'processing',
        isActive: false
      }).lean();

      if (stuckArticles.length > 0) {
        logger.info(`Recovering ${stuckArticles.length} stuck articles from previous session...`);
        for (const article of stuckArticles) {
          scheduleAiVerification(article, io);
        }
      }
    })
    .catch(err => {
      console.error('[AI-Verify] failed to run recovery sweep', err);
    });
}

module.exports = { scheduleAiVerification, verifyArticle, recoverStuckVerifications };
