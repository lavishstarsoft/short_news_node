'use strict';

/**
 * P4 — Emergency access override controller.
 *
 * Reporter (editor) can only REQUEST access (notifies their State In-Charge).
 * State In-Charge (subeditor) and Super Admin/Admin can GRANT/REVOKE. Every
 * mutation derives the actor from req.admin and re-verifies coverage server-side.
 * Never trusts a client-supplied granterId/dateKey; reporterId is validated and
 * must be a tiered editor under the granter's coverage (Super Admin unrestricted).
 */

const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const Notification = require('../models/Notification');
const ReporterAccessOverride = require('../models/ReporterAccessOverride');
const { isTierLimited, countReporterDailySubmissions, TIER_DAILY_LIMIT } = require('../utils/dailyLimitService');
const {
  resolveReporterStateIncharge,
  findReporterStateInchargeDoc,
  getManagedReporterIds,
  getReporterCoverage,
  getAdminId,
} = require('../utils/editorCoverageHelper');
const { resolveTierRate } = require('../utils/tierRewardService');
const {
  getActiveExtraAllowed,
  getTodayOverride,
  grantAccess,
  revokeAccess,
} = require('../utils/accessOverrideService');

const meId = (req) => (req.admin && (req.admin.id || req.admin._id)) || null;
const isSuper = (req) => !!(req.admin && (req.admin.role === 'superadmin' || req.admin.role === 'admin'));
const isSubEditor = (req) => !!(req.admin && req.admin.role === 'subeditor');

/** Validate + load a reporter that is actually a tiered editor. Returns doc | null. */
async function loadTieredReporter(reporterIdRaw) {
  const id = String(reporterIdRaw || '');
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const doc = await Admin.findById(id).select('name username role reporterTier assignedStates assignedState assignedDistricts assignedConstituencies assignedLocations location constituency');
  if (!doc || doc.role !== 'editor' || !isTierLimited(doc.reporterTier)) return null;
  return doc;
}

/** True if `granter` (fresh Admin doc / req.admin) may act on `reporterDoc`. */
async function granterCoversReporter(req, reporterDoc) {
  if (isSuper(req)) return true;
  if (!isSubEditor(req)) return false;
  // Load fresh sub-editor doc for authoritative coverage (never trust JWT payload).
  const subDoc = await Admin.findById(meId(req)).select('role permissions');
  if (!subDoc || subDoc.role !== 'subeditor') return false;
  const managed = await getManagedReporterIds(Admin, subDoc);
  if (managed === null) return true; // canViewAllNews → manages everyone
  return managed.includes(getAdminId(reporterDoc));
}

// POST /api/reporter/request-access — reporter only; NOTIFY the State In-Charge.
exports.requestAccess = async (req, res) => {
  try {
    const rid = meId(req);
    if (!rid) return res.status(401).json({ error: 'Authentication required.' });
    if (!req.admin || req.admin.role !== 'editor') {
      return res.status(403).json({ error: 'Only reporters can request access.' });
    }
    const reporter = await Admin.findById(rid).select('name username role reporterTier assignedStates assignedState assignedDistricts assignedConstituencies assignedLocations location constituency');
    if (!reporter || reporter.role !== 'editor' || !isTierLimited(reporter.reporterTier)) {
      return res.status(403).json({ error: 'Access requests are not applicable to your account.' });
    }

    const inchargeDoc = await findReporterStateInchargeDoc(Admin, reporter);
    const contact = await resolveReporterStateIncharge(Admin, reporter);

    if (inchargeDoc && getAdminId(inchargeDoc)) {
      const submitted = await countReporterDailySubmissions(rid);
      await Notification.create({
        title: 'Emergency Access Request',
        message: `${reporter.name || reporter.username || 'A reporter'} has reached the daily limit (${submitted}/${TIER_DAILY_LIMIT}) and is requesting extra submission access for today.`,
        type: 'admin',
        priority: 'high',
        recipients: [{ userId: String(getAdminId(inchargeDoc)) }],
        sentBy: 'system',
      });
    }

    // Never expose ids; only the human contact from the P2 resolver.
    return res.json({
      ok: true,
      notified: !!(inchargeDoc && getAdminId(inchargeDoc)),
      stateInCharge: contact, // { name, mobileNumber } | null
      message: contact
        ? 'Your request has been sent to your State In-Charge.'
        : 'No State In-Charge is currently mapped to your area. Please contact the office.',
    });
  } catch (e) {
    console.error('requestAccess error:', e.message);
    return res.status(500).json({ error: 'Could not send the request. Please try again.' });
  }
};

// GET /reporter-access — State In-Charge / Super Admin page.
exports.renderPage = (req, res) => {
  if (!isSuper(req) && !isSubEditor(req)) return res.status(403).send('Access denied.');
  res.render('reporter-access', { admin: req.admin, activePage: 'reporter-access' });
};

// GET /reporter-access/api/requests — today's tiered reporters under coverage + status.
exports.listRequests = async (req, res) => {
  try {
    if (!isSuper(req) && !isSubEditor(req)) return res.status(403).json({ error: 'Access denied.' });

    // ?all=1 → include reporters below the cap too (for the /editors hierarchy view).
    // Default (no flag) keeps the original "requests only" behaviour used by the
    // /admin/reporter-access page — additive + backward compatible.
    const includeAll = String(req.query.all || '') === '1';

    // Which reporters may this actor see? (coverage-scoped; IDOR preserved)
    let reporterFilter = { role: 'editor', reporterTier: { $in: ['stringer', 'district_incharge'] }, isActive: { $ne: false } };
    if (!isSuper(req)) {
      const subDoc = await Admin.findById(meId(req)).select('role permissions');
      const managed = await getManagedReporterIds(Admin, subDoc);
      if (managed !== null) {
        if (!managed.length) return res.json({ count: 0, items: [] });
        reporterFilter._id = { $in: managed };
      }
    }

    const reporters = await Admin.find(reporterFilter)
      .select('name username reporterTier assignedStates assignedState assignedDistricts assignedConstituencies assignedLocations location constituency isActive')
      .lean();

    const items = [];
    for (const r of reporters) {
      const submitted = await countReporterDailySubmissions(r._id);
      const extra = await getActiveExtraAllowed(r._id);
      // Surface reporters who are at/over the base cap OR already have an override,
      // unless includeAll is requested.
      if (!includeAll && submitted < TIER_DAILY_LIMIT && extra === 0) continue;

      const cov = getReporterCoverage(r);
      const effectiveLimit = TIER_DAILY_LIMIT + extra;
      const rate = await resolveTierRate(r.reporterTier);
      const inchargeDoc = await findReporterStateInchargeDoc(Admin, r);

      let status;
      if (r.isActive === false) status = 'blocked';
      else if (submitted >= effectiveLimit) status = 'at_limit';
      else if (extra > 0) status = 'extra_access';
      else status = 'active';

      items.push({
        reporterId: String(r._id),
        name: r.name || r.username || '',
        tier: r.reporterTier,
        ratePerNews: rate,
        state: cov.states[0] || '',
        district: cov.districts[0] || r.location || '',
        stateInChargeId: inchargeDoc ? String(getAdminId(inchargeDoc)) : '',
        stateInChargeName: inchargeDoc ? (inchargeDoc.name || inchargeDoc.username || 'State In-Charge') : '',
        stateInChargePhone: inchargeDoc ? (inchargeDoc.mobileNumber || '') : '',
        submittedToday: submitted,
        baseLimit: TIER_DAILY_LIMIT,
        extraAllowed: extra,
        effectiveLimit,
        status,
      });
    }
    res.json({ count: items.length, items });
  } catch (e) {
    console.error('listRequests error:', e.message);
    res.status(500).json({ error: 'Failed to load requests.' });
  }
};

// POST /reporter-access/api/grant  { reporterId, extra }
exports.grant = async (req, res) => {
  try {
    if (!isSuper(req) && !isSubEditor(req)) return res.status(403).json({ error: 'Access denied.' });
    const reporter = await loadTieredReporter(req.body && req.body.reporterId);
    if (!reporter) return res.status(400).json({ error: 'Invalid or ineligible reporter.' });
    if (getAdminId(reporter) === String(meId(req))) return res.status(403).json({ error: 'You cannot grant access to yourself.' });
    if (!(await granterCoversReporter(req, reporter))) {
      return res.status(403).json({ error: 'This reporter is not under your coverage.' });
    }
    const extra = Number(req.body && req.body.extra);
    if (!Number.isFinite(extra) || extra < 1 || extra > 10) {
      return res.status(400).json({ error: 'Extra must be between 1 and 10.' });
    }
    const r = await grantAccess({
      reporterId: getAdminId(reporter),
      reporterName: reporter.name || reporter.username || '',
      granter: req.admin,
      extra,
    });
    res.json(r);
  } catch (e) {
    console.error('grant error:', e.message);
    res.status(500).json({ error: 'Grant failed.' });
  }
};

// POST /reporter-access/api/revoke  { reporterId }
exports.revoke = async (req, res) => {
  try {
    if (!isSuper(req) && !isSubEditor(req)) return res.status(403).json({ error: 'Access denied.' });
    const reporter = await loadTieredReporter(req.body && req.body.reporterId);
    if (!reporter) return res.status(400).json({ error: 'Invalid or ineligible reporter.' });
    if (!(await granterCoversReporter(req, reporter))) {
      return res.status(403).json({ error: 'This reporter is not under your coverage.' });
    }
    const r = await revokeAccess({
      reporterId: getAdminId(reporter),
      reporterName: reporter.name || reporter.username || '',
      granter: req.admin,
    });
    if (!r.ok) return res.status(400).json({ error: r.error || 'Revoke failed.' });
    res.json(r);
  } catch (e) {
    console.error('revoke error:', e.message);
    res.status(500).json({ error: 'Revoke failed.' });
  }
};
