'use strict';

/**
 * Fire-and-forget duplicate scan for REPORTER / STRINGER (editor role) news.
 *
 * Unlike scheduleAiVerification (sub-editor AI gate), this is ADVISORY ONLY:
 *  - It NEVER changes isActive or aiStatus — the article stays in Pending News
 *    exactly as before, so the human approval workflow is untouched.
 *  - It only writes duplicateCheck + contentHash (same fields the pending page
 *    would compute lazily) and emits a live badge to admin dashboards.
 *  - Runs after the HTTP response is already sent → zero submission latency.
 *
 * This closes the gap where a reporter's re-upload was only checked when a State
 * In-charge happened to open the Pending News page.
 */

const { runDuplicateCheckGateway } = require('./runDuplicateCheckGateway');
const { normalizeDuplicateCheck } = require('../duplicateCheckService');
const { createAiLogger } = require('./logger');
// Phase-0 Same-Event SHADOW — compute-only, flag-gated (default OFF), never
// changes production behaviour. Safe to import/call unconditionally.
const { scheduleSameEventShadow } = require('./sameEvent/scheduleSameEventShadow');

const logger = createAiLogger({ isEnabled: () => true });

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scanArticle(news) {
  const News = require('../../models/News');
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await runDuplicateCheckGateway(
        {
          title: news.title,
          content: news.content,
          language: news.language,
          location: news.location,
          mediaUrl: news.mediaUrl,
          mediaType: news.mediaType,
          imageUrls: news.imageUrls,
          thumbnailUrl: news.thumbnailUrl,
          videoUrl: news.videoUrl,
        },
        { includePendingCorpus: true, excludeId: news._id },
      );

      const dc = normalizeDuplicateCheck(result.duplicateCheck || result);

      // Only a flag WITH a matched article to show is actionable (mirrors the
      // sub-editor gate + pending page — an empty flag must not show a badge).
      const hasComparison =
        Array.isArray(dc.similarArticles) && dc.similarArticles.length > 0;

      // Persist advisory result. Guard on contentHash so a concurrent edit's
      // result is never overwritten. Never touches isActive / aiStatus.
      const updateRes = await News.updateOne(
        { _id: news._id, contentHash: news.contentHash },
        {
          $set: {
            'duplicateCheck.isDuplicate': hasComparison ? dc.isDuplicate : false,
            'duplicateCheck.isSuspicious': hasComparison ? dc.isSuspicious : false,
            'duplicateCheck.score': dc.score || 0,
            'duplicateCheck.matchCount': hasComparison ? dc.matchCount : 0,
            'duplicateCheck.checkedAt': new Date(),
            'duplicateCheck.matchSource': dc.matchSource || null,
            'duplicateCheck.reasonLabel': dc.reasonLabel || null,
            'duplicateCheck.reasonMessage': dc.reasonMessage || null,
            'duplicateCheck.similarArticles': hasComparison ? dc.similarArticles : [],
            contentHash: result.contentHash || news.contentHash,
          },
        },
      );

      if (updateRes.matchedCount === 0) {
        return { outcome: 'skipped_hash_mismatch' };
      }

      const flagged = hasComparison && (dc.isDuplicate || dc.isSuspicious);
      logger.info(
        `reporter-scan newsId=${news._id} flagged=${flagged} score=${dc.score}`,
      );

      // Phase-0 Same-Event SHADOW (compute-only). No-op unless enabled. Passes
      // the production duplicateCheck so shadow-vs-production can be compared.
      // Never blocks, never throws into this path.
      try {
        scheduleSameEventShadow(news, {
          productionDuplicateCheck: {
            isDuplicate: hasComparison ? dc.isDuplicate : false,
            isSuspicious: hasComparison ? dc.isSuspicious : false,
            score: dc.score || 0,
          },
        });
      } catch (_) { /* shadow must never affect the reporter scan */ }
      return {
        outcome: flagged ? 'flagged' : 'clean',
        duplicateCheck: { ...dc, isDuplicate: hasComparison ? dc.isDuplicate : false, isSuspicious: hasComparison ? dc.isSuspicious : false },
      };
    } catch (err) {
      lastError = err;
      console.warn(
        `[Reporter-Scan] attempt ${attempt}/${MAX_RETRIES} failed newsId=${news._id}:`,
        err.message,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * attempt);
      }
    }
  }

  console.error(
    `[Reporter-Scan] gave up newsId=${news._id}:`,
    lastError && lastError.message,
  );
  return { outcome: 'error', error: lastError && lastError.message };
}

/** Fire-and-forget scheduler — never blocks the HTTP response. */
function scheduleReporterDuplicateScan(news, io) {
  Promise.resolve()
    .then(async () => {
      const result = await scanArticle(news);
      if (result.outcome === 'flagged' && io && result.duplicateCheck) {
        try {
          const dc = result.duplicateCheck;
          const { emitWorkflowToAdmins } = require('../realtime/workflowEmit');
          emitWorkflowToAdmins(io, {
            id: news._id,
            status: dc.isDuplicate ? 'duplicate' : 'suspicious',
            duplicateCheck: {
              isDuplicate: dc.isDuplicate,
              isSuspicious: dc.isSuspicious,
              score: dc.score,
              matchCount: dc.matchCount,
              matchSource: dc.matchSource,
              reasonLabel: dc.reasonLabel,
              reasonMessage: dc.reasonMessage,
              similarArticles: dc.similarArticles || [],
            },
          });
        } catch (_) {
          /* emit is non-critical */
        }
      }
    })
    .catch((err) => {
      console.error('[Reporter-Scan] unhandled error newsId=', news && news._id, err);
    });
}

module.exports = { scheduleReporterDuplicateScan, scanArticle };
