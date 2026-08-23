'use strict';

/**
 * P3 — Per-approved-news reward for TIERED reporters.
 *
 *  - stringer         → ₹5 per approved news
 *  - district_incharge→ ₹10 per approved news
 *  - reporterTier=null (every existing reporter) never reaches here → daily-bonus
 *    behaviour is fully preserved.
 *
 * Reuses the EXISTING wallet infrastructure (processWalletTransaction +
 * AdminWalletTransaction). One idempotent transaction per approved news
 * (referenceId = `newsreward_<newsId>`) → never double-credits on re-approval/retry.
 *
 * Cap: only the first 10 APPROVED news of the reporter's IST submission day are
 * rewardable; the 11th+ earns ₹0. Rank is computed by the immutable News `_id`
 * (submission order) so it is deterministic and retry-safe, and it reuses the
 * same IST/ObjectId-day semantics as the reward system. No old transaction is
 * ever modified.
 */

const AdminWalletTransaction = require('../models/AdminWalletTransaction');
const News = require('../models/News');
const { objectIdRangeForIstDay } = require('./indianDateTime');

// Default rates (preserve original P3 behaviour). The live rate is resolved from
// AppSettings at approval time via resolveTierRate(); these are the fallbacks.
const TIER_RATE = { stringer: 5, district_incharge: 10 };
const DAILY_REWARD_CAP = 10;
const RATE_FIELD = { stringer: 'stringerRatePerNews', district_incharge: 'districtInchargeRatePerNews' };

/** Default ₹ per approved news for a tier; 0 for null/legacy/unknown. Used as the
 *  "is this a tiered reporter?" gate and as the fallback when settings are unset. */
function tierRate(reporterTier) {
  return TIER_RATE[reporterTier] || 0;
}

/**
 * Live ₹ per approved news for a tier, read from AppSettings (update_flags) at
 * approval time. Falls back to the default when the field is missing/invalid.
 * Returns 0 for non-tiered reporters. Never throws.
 */
async function resolveTierRate(reporterTier) {
  const fallback = TIER_RATE[reporterTier];
  if (!fallback) return 0; // non-tiered
  const field = RATE_FIELD[reporterTier];
  try {
    const AppSettings = require('../models/AppSettings');
    const settings = await AppSettings.findOne({ key: 'update_flags' }).select(field).lean();
    const v = settings && settings[field];
    return (Number.isFinite(v) && v >= 0) ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

function buildNewsRewardReferenceId(newsId) {
  return `newsreward_${String(newsId)}`;
}

/**
 * Credit the per-news reward for a just-approved news (idempotent, capped).
 * @param {object} p
 * @param {object} p.news          approved news doc (needs _id, authorId)
 * @param {object} p.reporterAdmin reporter Admin doc (needs reporterTier)
 * @returns {Promise<{action:'credited'|'skipped', reason?:string, amount?:number, referenceId?:string, rank?:number}>}
 */
async function creditApprovedNewsReward({ news, reporterAdmin }) {
  const tier = reporterAdmin && reporterAdmin.reporterTier;
  if (!tierRate(tier)) return { action: 'skipped', reason: 'not_tiered' };

  const reporterId = news && news.authorId;
  if (!reporterId || !news._id) return { action: 'skipped', reason: 'no_author' };

  const referenceId = buildNewsRewardReferenceId(news._id);
  // Idempotency: this news was already rewarded → never double-credit.
  if (await AdminWalletTransaction.exists({ referenceId })) {
    return { action: 'skipped', reason: 'already_credited' };
  }

  // Cap by rank among the day's APPROVED news, ordered by immutable submission _id.
  const submissionDate = news._id.getTimestamp();
  const dayRange = objectIdRangeForIstDay(submissionDate);
  const approvedRank = await News.countDocuments({
    authorId: String(reporterId),
    isActive: true,
    'approvalStatus.isApproved': true,
    'rejectionStatus.isRejected': { $ne: true },
    _id: { $gte: dayRange.$gte, $lte: news._id },
  });
  if (approvedRank > DAILY_REWARD_CAP) {
    return { action: 'skipped', reason: 'daily_cap_reached', rank: approvedRank };
  }

  // Resolve the LIVE rate from AppSettings at approval time (default 5/10).
  const rate = await resolveTierRate(tier);
  if (!(rate > 0)) return { action: 'skipped', reason: 'zero_rate' };

  try {
    const { processWalletTransaction } = require('./walletHelpers');
    await processWalletTransaction({
      adminId: reporterId,
      amount: rate,
      type: 'credit',
      description: `Per-News Reward (${tier}) for approved news ${news._id}`,
      referenceId,
    });
  } catch (e) {
    // Unique referenceId race → another approval already credited this news.
    if (/duplicate key/i.test(e.message || '') || e.code === 11000) {
      return { action: 'skipped', reason: 'race_dedup' };
    }
    throw e;
  }

  return { action: 'credited', amount: rate, referenceId, rank: approvedRank };
}

module.exports = {
  TIER_RATE,
  DAILY_REWARD_CAP,
  tierRate,
  resolveTierRate,
  buildNewsRewardReferenceId,
  creditApprovedNewsReward,
};
