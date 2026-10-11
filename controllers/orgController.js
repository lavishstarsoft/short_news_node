'use strict';

/**
 * orgController.js — Super-Admin-only ORGANIZATION & ACCESS visibility pages
 * (Phase: Super Admin UI foundation). READ-ONLY. These pages make the new
 * permission catalog and the Step-3 shadow-mode system visible/understandable.
 *
 * They enforce NOTHING, change NO data, and are gated by requireSuperAdmin at the
 * route layer. No fake data: staff counts come from the real Admin collection and
 * shadow stats from the real AuthShadowLog. Departments/Teams/Roles do not exist
 * in the schema yet → the Organization page honestly shows them as "not configured".
 */

const Admin = require('../models/Admin');
const { PERMISSIONS } = require('../constants/permissions');

// Plain-language permission catalog for the Authorization page (non-technical).
const PERMISSION_CATALOG = [
  { group: 'Users / Staff', icon: 'fa-users', items: [
    { code: PERMISSIONS.USERS_VIEW, label: 'View staff', desc: 'See the staff/reporter directory.' },
    { code: PERMISSIONS.USERS_CREATE, label: 'Create staff', desc: 'Add a new staff member.' },
    { code: PERMISSIONS.USERS_EDIT, label: 'Edit staff', desc: 'Change a staff member’s details.' },
    { code: PERMISSIONS.USERS_DISABLE, label: 'Disable staff', desc: 'Deactivate an account.' },
    { code: PERMISSIONS.USERS_DELETE, label: 'Delete staff', desc: 'Permanently remove an account.' },
    { code: PERMISSIONS.USERS_IMPERSONATE, label: 'Impersonate', desc: 'View the dashboard as another user.' },
  ]},
  { group: 'Editorial / News', icon: 'fa-newspaper', items: [
    { code: PERMISSIONS.NEWS_VIEW, label: 'View news', desc: 'See news articles.' },
    { code: PERMISSIONS.NEWS_CREATE, label: 'Create news', desc: 'Submit a news article.' },
    { code: PERMISSIONS.NEWS_EDIT, label: 'Edit news', desc: 'Modify a news article.' },
    { code: PERMISSIONS.NEWS_APPROVE, label: 'Approve news', desc: 'Publish a submitted article.' },
    { code: PERMISSIONS.NEWS_REJECT, label: 'Reject news', desc: 'Send an article back / reject it.' },
  ]},
  { group: 'Field Operations', icon: 'fa-map-marker-alt', items: [
    { code: PERMISSIONS.REPORTERS_VIEW, label: 'View reporters', desc: 'See reporter details.' },
    { code: PERMISSIONS.ASSIGNMENTS_VIEW, label: 'View assignments', desc: 'See district/state assignments.' },
    { code: PERMISSIONS.ASSIGNMENTS_CREATE, label: 'Propose assignment', desc: 'Request a reporter assignment.' },
    { code: PERMISSIONS.ASSIGNMENTS_APPROVE, label: 'Approve assignment', desc: 'Confirm a proposed assignment.' },
  ]},
  { group: 'Accounts & Finance', icon: 'fa-wallet', items: [
    { code: PERMISSIONS.PAYMENTS_VIEW, label: 'View finance', desc: 'See wallets/transactions.' },
    { code: PERMISSIONS.PAYMENTS_ADJUST, label: 'Adjust wallet', desc: 'Manually credit/debit a wallet.' },
    { code: PERMISSIONS.PAYMENTS_PROCESS, label: 'Process payout', desc: 'Execute a withdrawal.' },
    { code: PERMISSIONS.PAYMENTS_APPROVE, label: 'Approve payment', desc: 'Authorize a held/earning payout.' },
    { code: PERMISSIONS.PAYMENTS_REVIEW, label: 'Review payment', desc: 'Check a payment before approval.' },
    { code: PERMISSIONS.PAYMENTS_EXPORT, label: 'Export ledger', desc: 'Download financial records.' },
    { code: PERMISSIONS.WALLET_FREEZE, label: 'Freeze wallet', desc: 'Block a reporter’s withdrawals.' },
  ]},
  { group: 'System / Security', icon: 'fa-shield-alt', items: [
    { code: PERMISSIONS.SETTINGS_MANAGE, label: 'Manage settings', desc: 'Change system settings.' },
    { code: PERMISSIONS.NOTIFICATIONS_SEND, label: 'Send notifications', desc: 'Broadcast notifications.' },
    { code: PERMISSIONS.AUDIT_VIEW, label: 'View audit log', desc: 'See the sensitive-action history.' },
    { code: PERMISSIONS.SECURITY_VIEW, label: 'View security', desc: 'See security events/alerts.' },
  ]},
];

async function renderOrganizationPage(req, res) {
  try {
    const connected = req.app.locals.isConnectedToMongoDB;
    let stats = { total: 0, active: 0, inactive: 0, byRole: [] };
    if (connected) {
      const [total, active, inactive, byRole] = await Promise.all([
        Admin.countDocuments({}),
        Admin.countDocuments({ isActive: { $ne: false } }),
        Admin.countDocuments({ isActive: false }),
        Admin.aggregate([{ $group: { _id: '$role', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      ]);
      stats = { total, active, inactive, byRole };
    }
    // Handbook data: structured content (constants/orgGuide.js) + LIVE facts.
    // Shadow status is read from the real system — never hard-coded.
    const guide = require('../constants/orgGuide');
    res.render('organization', {
      title: 'Organization & Access',
      admin: req.admin,
      activePage: 'organization',
      stats,
      guide,
      shadowOn: process.env.AUTH_SHADOW_MODE === 'true',
    });
  } catch (err) {
    console.error('renderOrganizationPage error:', err);
    res.status(500).send('Server Error');
  }
}

function renderAuthorizationPage(req, res) {
  res.render('authorization', {
    title: 'Authorization',
    admin: req.admin,
    activePage: 'authorization',
    catalog: PERMISSION_CATALOG,
  });
}

async function renderShadowModePage(req, res) {
  try {
    const shadowOn = process.env.AUTH_SHADOW_MODE === 'true';
    let stats = { total: 0, mismatch: 0, unknown: 0, recent: [], available: false };
    try {
      const AuthShadowLog = require('../models/AuthShadowLog');
      const [total, mismatch, unknown, recent] = await Promise.all([
        AuthShadowLog.countDocuments({}),
        AuthShadowLog.countDocuments({ comparison: 'MISMATCH' }),
        AuthShadowLog.countDocuments({ comparison: 'UNKNOWN' }),
        AuthShadowLog.find({ comparison: { $ne: 'MATCH' } }).sort({ createdAt: -1 }).limit(50).lean(),
      ]);
      stats = { total, mismatch, unknown, recent, available: true };
    } catch (_) { /* collection may not exist yet — page still renders */ }
    res.render('shadow-mode', {
      title: 'Shadow Mode',
      admin: req.admin,
      activePage: 'shadow-mode',
      shadowOn,
      stats,
    });
  } catch (err) {
    console.error('renderShadowModePage error:', err);
    res.status(500).send('Server Error');
  }
}

module.exports = { renderOrganizationPage, renderAuthorizationPage, renderShadowModePage };
