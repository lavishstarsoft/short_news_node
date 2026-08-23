'use strict';

/**
 * Reporter daily SUBMISSION limit for tiered reporters (P2).
 *
 * Scope:
 *  - Applies ONLY to reporterTier === 'stringer' | 'district_incharge'.
 *  - reporterTier === null (every existing reporter) is NOT limited → unchanged.
 *  - Counts submissions using the SAME IST / ObjectId-day semantics as the reward
 *    system (objectIdRangeForIstDay), so no schema field / migration is needed.
 *  - Counts pending + approved submissions; EXCLUDES rejected news.
 *  - Pure read helpers — no writes, no wallet/history/routing side effects.
 */

const News = require('../models/News');
const { objectIdRangeForIstDay } = require('./indianDateTime');

const TIER_DAILY_LIMIT = 10;
const LIMITED_TIERS = ['stringer', 'district_incharge'];
const LIMIT_MESSAGE =
  'You have reached the daily limit of 10 news. Please contact your State In-Charge.';

/** True only for tiers that carry the daily cap. null / undefined / anything else → false. */
function isTierLimited(reporterTier) {
  return LIMITED_TIERS.includes(reporterTier);
}

/**
 * Count today's (IST) submissions for a reporter, excluding rejected news.
 * @param {string|ObjectId} reporterId
 * @param {Date} [when]  a moment inside the IST day to evaluate (defaults to now)
 * @returns {Promise<number>}
 */
async function countReporterDailySubmissions(reporterId, when) {
  return News.countDocuments({
    authorId: String(reporterId),
    _id: objectIdRangeForIstDay(when || new Date()),
    'rejectionStatus.isRejected': { $ne: true },
  });
}

module.exports = {
  TIER_DAILY_LIMIT,
  LIMITED_TIERS,
  LIMIT_MESSAGE,
  isTierLimited,
  countReporterDailySubmissions,
};
