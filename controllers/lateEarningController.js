'use strict';

/**
 * lateEarningController — Super Admin queue to release/send-back reporter day-rewards
 * that were HELD due to a late (next-day) State In-Charge approval, plus read-only
 * stats for the State In-Charge and the reporter.
 *
 * SECURITY: release/send-back are Super-Admin-only (server-side). Listing is
 * admin/superadmin. Reporter pending is scoped to the logged-in reporter only.
 */

const LateApprovalEarning = require('../models/LateApprovalEarning');
const LateApprovalReason = require('../models/LateApprovalReason');
const svc = require('../services/earning/lateApprovalService');

const isSuperAdmin = (req) => !!(req.admin && req.admin.role === 'superadmin');
const isAdmin = (req) => !!(req.admin && (req.admin.role === 'admin' || req.admin.role === 'superadmin'));
const meId = (req) => (req.admin && (req.admin.id || req.admin._id)) || req.adminId || req.userId || null;

// GET page (Super Admin).
exports.renderQueue = (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).send('Access denied. Super Admin only.');
  res.render('late-earnings', { admin: req.admin, activePage: 'late-earnings' });
};

// GET pending/held list (admin+superadmin can view; only superadmin can act).
exports.listPending = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
  const status = String(req.query.status || 'pending_superadmin_review');
  const q = status === 'all' ? {} : { earningStatus: status };
  const rows = await LateApprovalEarning.find(q).sort({ createdAt: -1 }).limit(500).lean();
  // Attach the immutable typed reason + severity type (by newsId) for transparency.
  const reasons = await LateApprovalReason.find({ newsId: { $in: rows.map(r => r.newsId) } })
    .select('newsId newsTitle lateApprovalType lateApprovalReason').lean();
  const byNews = new Map(reasons.map(x => [x.newsId, x]));
  const items = rows.map(r => {
    const rr = byNews.get(r.newsId);
    return { ...r, newsTitle: rr ? rr.newsTitle : '', lateApprovalType: rr ? rr.lateApprovalType : 'day_late', lateApprovalReason: rr ? rr.lateApprovalReason : '' };
  });
  res.json({ count: items.length, items });
};

// GET full accountability log (both same-day-late and day-late), Super Admin visibility.
exports.listReasons = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
  const q = {};
  if (req.query.type === 'same_day_late' || req.query.type === 'day_late') q.lateApprovalType = req.query.type;
  if (req.query.inchargeId) q.stateInchargeId = req.query.inchargeId;
  const rows = await LateApprovalReason.find(q).sort({ createdAt: -1 }).limit(500).lean();
  res.json({ count: rows.length, items: rows });
};

// POST release (Super Admin only) — credits once + audit.
exports.release = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const r = await svc.releasePending(req.params.id, req.admin, String((req.body && req.body.note) || ''));
  if (!r.ok) return res.status(r.error === 'not_found' ? 404 : 400).json({ error: r.error || 'Failed' });
  res.json(r);
};

// POST send back (Super Admin only).
exports.sendBack = async (req, res) => {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const r = await svc.sendBack(req.params.id, req.admin, String((req.body && req.body.note) || ''));
  if (!r.ok) return res.status(r.error === 'not_found' ? 404 : 400).json({ error: r.error || 'Failed' });
  res.json(r);
};

// GET State In-Charge stats (own, or a given inchargeId for admins).
exports.inchargeStats = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
  const inchargeId = String(req.query.inchargeId || meId(req) || '');
  if (!inchargeId) return res.status(400).json({ error: 'inchargeId required.' });
  const rows = await LateApprovalEarning.find({ stateInchargeId: inchargeId }).select('approvalDelayMinutes earningStatus warningGeneratedAt').lean();
  const total = rows.length;
  const pending = rows.filter(r => r.earningStatus === 'pending_superadmin_review').length;
  const avgDelay = total ? Math.round(rows.reduce((s, r) => s + (r.approvalDelayMinutes || 0), 0) / total) : 0;
  const warnings = rows.filter(r => r.warningGeneratedAt).length;
  const level = total >= 5 ? 'flagged' : total >= 2 ? 'escalated' : total === 1 ? 'warning' : 'none';
  res.json({ inchargeId, lateApprovals: total, pendingApprovals: pending, averageApprovalDelayMinutes: avgDelay, warningCount: warnings, warningLevel: level });
};

// GET reporter's own pending earnings (scoped to the logged-in reporter).
exports.reporterPending = async (req, res) => {
  const rid = meId(req);
  if (!rid) return res.status(401).json({ error: 'Auth required.' });
  const rows = await LateApprovalEarning.find({ reporterId: rid }).sort({ createdAt: -1 }).limit(200).lean();
  res.json({
    count: rows.length,
    items: rows.map(r => ({
      newsId: r.newsId, submittedAt: r.submittedAt, approvedAt: r.approvedAt,
      approvalDelayMinutes: r.approvalDelayMinutes, amount: r.earningAmount, status: r.earningStatus,
      releasedAmount: r.earningStatus === 'released' ? r.earningAmount : 0, earningReleasedAt: r.earningReleasedAt,
      reason: r.earningStatus === 'pending_superadmin_review'
        ? 'Your earning is pending because this news was approved late. Super Admin verification is pending.'
        : r.earningStatus === 'released' ? 'Released by Super Admin.' : 'Sent back for review.'
    }))
  });
};
