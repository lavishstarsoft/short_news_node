'use strict';

/**
 * Single source of truth for the reporter daily-reward calculation.
 *
 * Business rules:
 *  - The reward belongs to the day the reporter SUBMITTED the news.
 *  - Submission day is derived from the immutable News ObjectId creation time
 *    (_id.getTimestamp()), evaluated in Asia/Kolkata. No submittedAt field,
 *    no schema change, no migration.
 *  - Admin approval only determines ELIGIBILITY (approvalStatus.isApproved).
 *
 * Both checkAndCreditWallet() and getReporterDailyStats() call evaluateDailyReward()
 * so there is exactly one implementation of the reward logic.
 */

const Admin = require('../models/Admin');
const News = require('../models/News');
const AppSettings = require('../models/AppSettings');
const AdminWalletTransaction = require('../models/AdminWalletTransaction');
const { istDateKey, objectIdRangeForIstDay } = require('./indianDateTime');

/** Single referenceId generator used everywhere (idempotency + IST reward day). */
function buildRewardReferenceId(reporterId, istDayKey) {
  return `reward_${String(reporterId)}_${istDayKey}`;
}

/**
 * Evaluate the daily reward for a reporter on the IST day that contains `submissionDate`.
 *
 * @param {string|ObjectId} reporterId  Admin (reporter) id.
 * @param {Date}            submissionDate  A moment inside the submission day to evaluate
 *                                          (e.g. approvedArticle._id.getTimestamp() or "now").
 * @returns {{
 *   found:boolean, enabled:boolean, admin:object|null,
 *   targetNews:number, maxReward:number, amountPerNews:number,
 *   approvedCount:number, eligible:boolean,
 *   dateKey:string, referenceId:string, alreadyCredited:boolean
 * }}
 */
async function evaluateDailyReward(reporterId, submissionDate) {
  const when = submissionDate || new Date();
  const dateKey = istDateKey(when);
  const referenceId = buildRewardReferenceId(reporterId, dateKey);

  const admin = await Admin.findById(reporterId);
  if (!admin) {
    return {
      found: false, enabled: false, admin: null,
      targetNews: 0, maxReward: 0, amountPerNews: 0,
      approvedCount: 0, eligible: false, dateKey, referenceId, alreadyCredited: false,
    };
  }

  const settings = await AppSettings.findOne({ key: 'update_flags' });
  // Lazy require avoids a load-time cycle with walletHelpers.
  const { resolveWalletConfig } = require('./walletHelpers');
  const { enabled, targetNews, maxReward } = resolveWalletConfig(admin, settings);
  const amountPerNews = targetNews > 0 ? maxReward / targetNews : 0;

  if (!enabled) {
    return {
      found: true, enabled: false, admin,
      targetNews, maxReward, amountPerNews,
      approvedCount: 0, eligible: false, dateKey, referenceId, alreadyCredited: false,
    };
  }

  // Approved submissions whose immutable _id creation time falls in this IST day.
  // Approval status is used ONLY as the eligibility filter — never as the day.
  const approvedCount = await News.countDocuments({
    authorId: String(reporterId),
    isActive: true,
    'approvalStatus.isApproved': true,
    _id: objectIdRangeForIstDay(when),
  });

  const alreadyCredited = !!(await AdminWalletTransaction.exists({ referenceId }));

  return {
    found: true, enabled: true, admin,
    targetNews, maxReward, amountPerNews,
    approvedCount, eligible: approvedCount >= targetNews,
    dateKey, referenceId, alreadyCredited,
  };
}

module.exports = {
  buildRewardReferenceId,
  evaluateDailyReward,
};
