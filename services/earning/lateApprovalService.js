'use strict';

/**
 * lateApprovalService — decides, at news-approval time, whether the reporter's
 * DAILY reward should be credited immediately (same-day approval → existing
 * behaviour) or HELD for Super Admin review (late/next-day approval).
 *
 * NOTHING here changes the reward amount, target, eligibility, reward-day, or wallet
 * math. It only gates the moment of crediting and records accountability.
 */

const { istDateKey } = require('../../utils/indianDateTime');
const LateApprovalEarning = require('../../models/LateApprovalEarning');

/** Late = the approval falls on a strictly later IST day than the submission. */
function isLate(submissionDate, approvalDate) {
  const s = istDateKey(submissionDate);
  const a = istDateKey(approvalDate);
  return !!(s && a && a > s); // YYYY-MM-DD strings are lexicographically ordered
}

function delayMinutes(submissionDate, approvalDate) {
  return Math.max(0, Math.round((new Date(approvalDate).getTime() - new Date(submissionDate).getTime()) / 60000));
}

/**
 * Called from approveNews AFTER the article is marked approved.
 * @param {object} p
 * @param {object} p.news        the pre-update news doc (has _id, authorId)
 * @param {Date}   p.approvedAt  approval timestamp
 * @param {object} p.approver    { id, name, role } — the State In-Charge/admin who approved
 * @returns {Promise<{action:'credited'|'held'|'skipped', reason?:string}>}
 */
async function handleApprovalEarning({ news, approvedAt, approver }) {
  const reporterId = news && news.authorId;
  if (!reporterId) return { action: 'skipped', reason: 'no_author' };

  const submissionDate = news._id.getTimestamp();
  const approvalDate = approvedAt || new Date();

  // Reuse the single source of truth for the reward (amount/target/eligibility/day/idempotency).
  const { evaluateDailyReward } = require('../../utils/dailyRewardService');
  const { checkAndCreditWallet } = require('../../utils/walletHelpers');
  const reward = await evaluateDailyReward(reporterId, submissionDate);

  if (!reward.found || !reward.admin || !['editor', 'subeditor'].includes(reward.admin.role)) return { action: 'skipped', reason: 'not_reporter' };

  // P3 — Tiered reporters (stringer / district_incharge) earn a PER-NEWS reward
  // (₹5 / ₹10) instead of the daily bonus. Returning here guarantees they never
  // receive both. reporterTier=null falls through to the unchanged daily-bonus path.
  const { tierRate, creditApprovedNewsReward } = require('../../utils/tierRewardService');
  if (tierRate(reward.admin.reporterTier) > 0) {
    return await creditApprovedNewsReward({ news, reporterAdmin: reward.admin });
  }

  if (!reward.enabled) return { action: 'skipped', reason: 'wallet_disabled' };
  if (reward.alreadyCredited) return { action: 'skipped', reason: 'already_credited' };

  const late = isLate(submissionDate, approvalDate);

  // Same-day approval → existing automatic behaviour, UNCHANGED …
  if (!late) {
    // …unless a pending hold already exists for this day (respect it — never bypass).
    const held = await LateApprovalEarning.findOne({ referenceId: reward.referenceId, earningStatus: 'pending_superadmin_review' }).lean();
    if (held) return { action: 'skipped', reason: 'on_hold' };
    await checkAndCreditWallet(reporterId, submissionDate);
    return { action: 'credited' };
  }

  // Late approval → only hold when the reward is actually DUE now (target met, not yet credited).
  if (!reward.eligible) return { action: 'skipped', reason: 'not_eligible_yet' };

  // Idempotent hold: exactly one per reporter+day (unique referenceId).
  const existing = await LateApprovalEarning.findOne({ referenceId: reward.referenceId }).lean();
  if (existing) return { action: 'held', reason: 'already_held' };

  let doc;
  try {
    doc = await LateApprovalEarning.create({
      referenceId: reward.referenceId,
      dateKey: reward.dateKey,
      reporterId,
      reporterName: reward.admin.username || reward.admin.name || '',
      newsId: String(news._id),
      stateInchargeId: approver && approver.id ? approver.id : null,
      stateInchargeName: (approver && approver.name) || '',
      stateInchargeRole: (approver && approver.role) || '',
      submittedAt: submissionDate,
      approvedAt: approvalDate,
      approvalDelayMinutes: delayMinutes(submissionDate, approvalDate),
      lateApproval: true,
      earningAmount: reward.maxReward,
      earningStatus: 'pending_superadmin_review',
      warningGeneratedAt: new Date()
    });
  } catch (e) {
    if (e && e.code === 11000) return { action: 'held', reason: 'race_dedup' }; // unique referenceId won the race
    throw e;
  }

  // Fire-and-forget accountability: In-Charge warning + Super Admin alert + audit.
  notifyAndAudit(doc).catch((err) => console.error('lateApproval notify error:', err.message));
  return { action: 'held' };
}

async function notifyAndAudit(doc) {
  const Admin = require('../../models/Admin');
  const Notification = require('../../models/Notification');
  const AuditLog = require('../../models/AuditLog');

  const details = `Reporter: ${doc.reporterName} | News: ${doc.newsId} | Submitted: ${doc.submittedAt.toISOString()} | Approved: ${doc.approvedAt.toISOString()} | Delay: ${doc.approvalDelayMinutes} min | Pending reward: ₹${doc.earningAmount}`;

  // Escalation level based on how many late holds this In-Charge already has.
  let level = 'warning';
  if (doc.stateInchargeId) {
    const cnt = await LateApprovalEarning.countDocuments({ stateInchargeId: doc.stateInchargeId });
    level = cnt >= 5 ? 'flagged' : cnt >= 2 ? 'escalated' : 'warning';
    if (level === 'flagged') {
      try { require('../security/alertEngine').record({ type: 'suspicious_session', severity: 'MEDIUM', account: String(doc.stateInchargeId), endpoint: '/admin/late-earnings', message: `State In-Charge ${doc.stateInchargeName} has ${cnt} late approvals (flagged)`, details: { context: 'late_approval' } }); } catch (_) {}
    }
  }

  // In-Charge warning.
  if (doc.stateInchargeId) {
    try {
      await Notification.create({
        title: level === 'flagged' ? 'Late Approval — Flagged for Review' : level === 'escalated' ? 'Repeated Late Approval Warning' : 'Late Approval Warning',
        message: `You approved a news after its submission day. The reporter's reward is now pending Super Admin verification. ${details}`,
        type: 'admin', priority: level === 'warning' ? 'high' : 'urgent',
        newsId: doc.newsId, recipients: [{ userId: String(doc.stateInchargeId) }], sentBy: 'system'
      });
    } catch (_) {}
  }

  // Super Admin alert (all superadmins).
  try {
    const supers = await Admin.find({ role: 'superadmin', isActive: { $ne: false } }).select('_id').lean();
    if (supers.length) {
      await Notification.create({
        title: 'Late Approval — Reporter Earning Pending Release',
        message: `${details} | State In-Charge: ${doc.stateInchargeName} (${level}). Review & release in Late Earnings.`,
        type: 'admin', priority: 'urgent',
        newsId: doc.newsId, recipients: supers.map(s => ({ userId: String(s._id) })), sentBy: 'system'
      });
    }
  } catch (_) {}

  // Immutable audit.
  try {
    await AuditLog.create({
      actorName: 'system:late-approval', actorRole: 'system',
      action: 'late_approval_earning_hold', entityType: 'LateApprovalEarning', entityId: String(doc._id),
      targetId: doc.reporterId, targetName: doc.reporterName,
      description: `Held daily reward ₹${doc.earningAmount} for ${doc.dateKey} — late approval by ${doc.stateInchargeName} (${doc.approvalDelayMinutes} min, level=${level})`,
      before: { earningStatus: null },
      after: { earningStatus: 'pending_superadmin_review', referenceId: doc.referenceId, newsId: doc.newsId, stateInchargeId: String(doc.stateInchargeId || ''), approvalDelayMinutes: doc.approvalDelayMinutes, warningLevel: level }
    });
  } catch (_) {}
}

/** Super Admin releases a held day-reward → credit ONCE (unique referenceId) + audit. */
async function releasePending(recordId, superAdmin, note = '') {
  const doc = await LateApprovalEarning.findById(recordId);
  if (!doc) return { ok: false, error: 'not_found' };
  if (doc.earningStatus === 'released') return { ok: true, already: true, message: 'Already released.' };

  const { processWalletTransaction } = require('../../utils/walletHelpers');
  const AdminWalletTransaction = require('../../models/AdminWalletTransaction');
  const AuditLog = require('../../models/AuditLog');

  const before = { earningStatus: doc.earningStatus, earningReleasedAt: doc.earningReleasedAt };

  // Credit only if not already credited (unique referenceId is the hard guarantee).
  const already = await AdminWalletTransaction.exists({ referenceId: doc.referenceId });
  if (!already) {
    try {
      await processWalletTransaction({
        adminId: doc.reporterId, amount: doc.earningAmount, type: 'credit',
        description: `Daily Reward (released by Super Admin) for ${doc.dateKey}`,
        referenceId: doc.referenceId
      });
    } catch (e) {
      if (!/duplicate key/i.test(e.message || '')) throw e; // unique referenceId race → already credited
    }
  }

  const now = new Date();
  doc.earningStatus = 'released';
  doc.earningReleasedAt = now;
  doc.earningReleaseDate = istDateKey(now); // release day — does NOT rewrite submittedAt
  doc.superAdminAction = { byId: (superAdmin && (superAdmin.id || superAdmin._id)) || null, byName: (superAdmin && (superAdmin.username || superAdmin.name)) || '', action: 'released', at: now, note };
  await doc.save();

  try {
    await AuditLog.create({
      actorId: (superAdmin && (superAdmin.id || superAdmin._id)) || null, actorName: (superAdmin && (superAdmin.username || superAdmin.name)) || '', actorRole: (superAdmin && superAdmin.role) || 'superadmin',
      action: 'late_approval_earning_release', entityType: 'LateApprovalEarning', entityId: String(doc._id),
      targetId: doc.reporterId, targetName: doc.reporterName,
      description: `Released ₹${doc.earningAmount} for ${doc.dateKey} (referenceId ${doc.referenceId})`,
      before, after: { earningStatus: 'released', earningReleasedAt: now, earningReleaseDate: doc.earningReleaseDate }
    });
  } catch (_) {}

  return { ok: true, released: true, amount: doc.earningAmount, referenceId: doc.referenceId };
}

/** Super Admin sends a held reward back (no credit). */
async function sendBack(recordId, superAdmin, note = '') {
  const doc = await LateApprovalEarning.findById(recordId);
  if (!doc) return { ok: false, error: 'not_found' };
  if (doc.earningStatus === 'released') return { ok: false, error: 'already_released' };
  const AuditLog = require('../../models/AuditLog');
  const before = { earningStatus: doc.earningStatus };
  doc.earningStatus = 'sent_back';
  doc.superAdminAction = { byId: (superAdmin && (superAdmin.id || superAdmin._id)) || null, byName: (superAdmin && (superAdmin.username || superAdmin.name)) || '', action: 'sent_back', at: new Date(), note };
  await doc.save();
  try { await AuditLog.create({ actorId: (superAdmin && (superAdmin.id || superAdmin._id)) || null, actorName: (superAdmin && (superAdmin.username || superAdmin.name)) || '', actorRole: 'superadmin', action: 'late_approval_earning_send_back', entityType: 'LateApprovalEarning', entityId: String(doc._id), targetId: doc.reporterId, targetName: doc.reporterName, description: `Sent back ${doc.referenceId}`, before, after: { earningStatus: 'sent_back', note } }); } catch (_) {}
  return { ok: true, sentBack: true };
}

/**
 * Classify an approval's lateness relative to submission.
 *  - on_time       : delay <= 30:00 AND same IST calendar day
 *  - same_day_late : delay  > 30:00, same IST calendar day (reason required, NO wallet freeze)
 *  - day_late      : approval crossed the submission IST calendar day (reason + earning hold)
 * day_late always wins even if the minute-delay is < 30 (e.g. 11:59 PM → 12:00 AM).
 */
function classifyLateness(submissionDate, attemptDate) {
  const delayMs = new Date(attemptDate).getTime() - new Date(submissionDate).getTime();
  const mins = Math.max(0, Math.round(delayMs / 60000));
  const dayLate = isLate(submissionDate, attemptDate);
  const over30 = delayMs > 30 * 60 * 1000; // strictly greater than 30:00 → late
  const type = dayLate ? 'day_late' : (over30 ? 'same_day_late' : 'on_time');
  return { delayMinutes: mins, dayLate, over30, late: dayLate || over30, type };
}

/** Backend-enforced reason validation (never trust the client). Anti-gibberish. */
function isValidReason(text) {
  const t = String(text || '').trim();
  if (t.length < 15) return false;
  // Words with at least 2 letter-ish chars (supports Latin + Devanagari + Telugu).
  const words = t.split(/\s+/).filter((w) => (w.match(/[a-zA-Zऀ-ॿఀ-౿]/g) || []).length >= 2);
  if (words.length < 3) return false;
  if (new Set(words.map((w) => w.toLowerCase())).size < 2) return false; // e.g. "aaa aaa aaa"
  if (new Set(t.toLowerCase().replace(/\s/g, '')).size < 6) return false; // too few distinct chars
  const trivial = new Set(['ok', 'okay', 'busy', 'other', 'na', 'n/a', 'none', 'done', 'yes', 'no', 'test', 'asdf', 'fine', 'late', 'sorry']);
  if (trivial.has(t.toLowerCase())) return false;
  return true;
}

/**
 * Record the immutable late-approval reason + accountability (per news, idempotent
 * by newsId). For same_day_late it also raises the In-Charge warning + Super-Admin
 * visibility (day_late notifications are already raised by handleApprovalEarning).
 */
async function recordLateApprovalReason({ news, approver, submittedAt, attemptAt, approvedAt, type, reason }) {
  const LateApprovalReason = require('../../models/LateApprovalReason');
  const newsId = String(news._id);
  const existing = await LateApprovalReason.findOne({ newsId }).lean();
  if (existing) return { recorded: false, reason: 'already_recorded' };

  const reporterId = news.authorId;
  let reporterName = '', amount = 0, referenceId = '';
  try {
    const { evaluateDailyReward } = require('../../utils/dailyRewardService');
    const rw = await evaluateDailyReward(reporterId, submittedAt);
    reporterName = (rw.admin && (rw.admin.username || rw.admin.name)) || '';
    amount = rw.maxReward || 0; referenceId = rw.referenceId || '';
  } catch (_) {}

  const earningStatus = type === 'day_late' ? 'pending_superadmin_review' : 'auto_credited';
  let doc;
  try {
    doc = await LateApprovalReason.create({
      newsId, newsTitle: news.title || '',
      reporterId, reporterName,
      stateInchargeId: approver && approver.id ? approver.id : null,
      stateInchargeName: (approver && approver.name) || '',
      submittedAt, approvalAttemptAt: attemptAt, approvedAt,
      approvalDelayMinutes: Math.max(0, Math.round((new Date(approvedAt) - new Date(submittedAt)) / 60000)),
      lateApproval: true, lateApprovalType: type, lateApprovalReason: String(reason || '').trim(),
      earningAmount: amount, earningStatus, referenceId
    });
  } catch (e) {
    if (e && e.code === 11000) return { recorded: false, reason: 'race_dedup' };
    throw e;
  }

  // Same-day-late: no financial notification happens elsewhere → notify here.
  if (type === 'same_day_late') {
    try {
      const Admin = require('../../models/Admin');
      const Notification = require('../../models/Notification');
      if (doc.stateInchargeId) {
        await Notification.create({ title: 'Late Approval (Same-Day) Recorded', message: `You approved a news ${doc.approvalDelayMinutes} min after submission. Reason recorded for accountability. Reporter earning is unaffected.`, type: 'admin', priority: 'high', newsId, recipients: [{ userId: String(doc.stateInchargeId) }], sentBy: 'system' });
      }
      const supers = await Admin.find({ role: 'superadmin', isActive: { $ne: false } }).select('_id').lean();
      if (supers.length) await Notification.create({ title: 'Same-Day Late Approval', message: `Reporter: ${doc.reporterName} | News: ${newsId} | Delay: ${doc.approvalDelayMinutes} min | In-Charge: ${doc.stateInchargeName} | Reason: ${doc.lateApprovalReason}`, type: 'admin', priority: 'normal', newsId, recipients: supers.map((s) => ({ userId: String(s._id) })), sentBy: 'system' });
    } catch (_) {}
  }

  try {
    require('../../models/AuditLog').create({
      actorId: approver && approver.id ? approver.id : null, actorName: (approver && approver.name) || '', actorRole: (approver && approver.role) || '',
      action: 'late_approval_reason', entityType: 'LateApprovalReason', entityId: String(doc._id),
      targetId: reporterId, targetName: reporterName,
      description: `${type} approval reason recorded for news ${newsId} (${doc.approvalDelayMinutes} min)`,
      before: null, after: { lateApprovalType: type, lateApprovalReason: doc.lateApprovalReason, earningStatus }
    });
  } catch (_) {}

  return { recorded: true, id: String(doc._id), type, earningStatus };
}

module.exports = { isLate, delayMinutes, classifyLateness, isValidReason, handleApprovalEarning, recordLateApprovalReason, releasePending, sendBack };
