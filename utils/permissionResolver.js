'use strict';

/**
 * permissionResolver.js — PURE, READ-ONLY permission calculator (Phase 0, Step 1).
 *
 * Given a user's EXISTING fields (role, displayRole, permissions{}, reporterTier,
 * assignedState(s), managedDistricts, managedReporterIds, …) it computes the
 * effective permission set + scope the user has TODAY. It is a faithful MIRROR of
 * current behaviour — it neither grants nor removes any access, performs no I/O,
 * mutates nothing, and is wired to NOTHING. It exists purely so a later shadow-mode
 * layer can compare "what the new model says" against "what the old code does".
 *
 * Determinism contract: resolve(sameInput) === resolve(sameInput); the input object
 * is never modified.
 */

const { PERMISSIONS: P, ALL_PERMISSIONS, ADMIN_PERMISSIONS, SCOPE } = require('../constants/permissions');

/** Normalize messy free-text (trailing spaces, "Sub Editor" vs "Sub-Editor"). */
function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/[\s._-]+/g, ' ').trim();
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean);
  if (v == null || v === '') return [];
  return [v];
}

/** State-In-Charge = a sub-editor with assigned states OR an "incharge" display label. */
function detectStateIncharge(user) {
  if (user.role !== 'subeditor') return false;
  const states = asArray(user.assignedStates).length ? asArray(user.assignedStates) : asArray(user.assignedState);
  if (states.length > 0) return true;
  const dr = norm(user.displayRole);
  // e.g. "state in charge", "karnataka incharge", "mh incharge"
  return /\bin ?charge\b/.test(dr);
}

/**
 * @param {object} user - a plain object or Mongoose .lean() doc (never mutated).
 * @returns {object} effective descriptor { role, flags, permissions[], scope, reporterTier }
 */
function resolve(user) {
  const u = user || {};
  const role = u.role || null;
  const perms = (u.permissions && typeof u.permissions === 'object') ? u.permissions : {};

  const out = {
    role,
    displayRole: u.displayRole || '',
    reporterTier: u.reporterTier || null, // earnings attribute only — grants NO access
    isSuperAdmin: role === 'superadmin',
    isAdmin: role === 'admin',
    isSubeditor: role === 'subeditor',
    isReporter: role === 'editor',
    isStateIncharge: false,
    isDistrictIncharge: u.reporterTier === 'district_incharge' || asArray(u.managedDistricts).length > 0,
    dashboardAccess: false,
    permissions: [],
    scope: { type: SCOPE.NONE, states: [], districts: [], reporterIds: [] },
  };

  const grant = new Set();

  // ── Super Admin: everything, global ──────────────────────────────────────
  if (role === 'superadmin') {
    ALL_PERMISSIONS.forEach((p) => grant.add(p));
    out.dashboardAccess = true;
    out.scope = { type: SCOPE.GLOBAL, states: [], districts: [], reporterIds: [] };
    out.permissions = Array.from(grant);
    return out;
  }

  // ── Admin (defensive; absent in current data): full operational set, global ─
  if (role === 'admin') {
    ADMIN_PERMISSIONS.forEach((p) => grant.add(p));
    out.dashboardAccess = true;
    out.scope = { type: SCOPE.GLOBAL, states: [], districts: [], reporterIds: [] };
    out.permissions = Array.from(grant);
    return out;
  }

  // ── Sub-Editor: capabilities come from the per-user permissions bag + scope ─
  if (role === 'subeditor') {
    out.dashboardAccess = perms.canAccessAdminDashboard === true;

    // News capabilities (scoped) — mirror the current flags.
    grant.add(P.NEWS_VIEW);
    if (perms.canViewAllNews === true) grant.add(P.NEWS_VIEW);
    if (perms.canApproveNews === true) { grant.add(P.NEWS_APPROVE); grant.add(P.NEWS_REJECT); }
    if (perms.canEditNews === true) grant.add(P.NEWS_EDIT);
    if (perms.canSendNotifications === true) grant.add(P.NOTIFICATIONS_SEND);
    if (perms.canViewReporterDetails === true) grant.add(P.REPORTERS_VIEW);

    // State-In-Charge: propose assignments within their state(s); view reporters.
    out.isStateIncharge = detectStateIncharge(u);
    if (out.isStateIncharge) {
      grant.add(P.ASSIGNMENTS_VIEW);
      grant.add(P.ASSIGNMENTS_CREATE);
      grant.add(P.REPORTERS_VIEW);
    }

    // Scope resolution (described, not DB-resolved).
    const states = asArray(u.assignedStates).length ? asArray(u.assignedStates) : asArray(u.assignedState);
    const districts = asArray(u.managedDistricts);
    const reporterIds = asArray(u.managedReporterIds);
    if (perms.canViewAllNews === true) {
      out.scope = { type: SCOPE.GLOBAL, states: [], districts: [], reporterIds: [] };
    } else if (states.length) {
      out.scope = { type: SCOPE.STATE, states, districts, reporterIds };
    } else if (districts.length) {
      out.scope = { type: SCOPE.DISTRICT, states: [], districts, reporterIds };
    } else if (reporterIds.length) {
      out.scope = { type: SCOPE.REPORTERS, states: [], districts: [], reporterIds };
    } else {
      out.scope = { type: SCOPE.MANAGED, states: [], districts: [], reporterIds: [] };
    }

    // Sub-editors NEVER receive finance / user-management / settings today.
    out.permissions = Array.from(grant);
    return out;
  }

  // ── Reporter (role 'editor'): own news + self wallet only ─────────────────
  if (role === 'editor') {
    grant.add(P.NEWS_CREATE);
    grant.add(P.NEWS_VIEW);
    grant.add(P.WALLET_SELF);
    out.dashboardAccess = false;
    out.scope = { type: SCOPE.OWN, states: [], districts: [], reporterIds: [] };
    out.permissions = Array.from(grant);
    return out;
  }

  // ── Unknown / no role: safe deny-all ──────────────────────────────────────
  out.permissions = [];
  out.scope = { type: SCOPE.NONE, states: [], districts: [], reporterIds: [] };
  return out;
}

/** Convenience: does this user's effective set include `permission`? (Pure.) */
function can(user, permission) {
  return resolve(user).permissions.includes(permission);
}

module.exports = { resolve, can, norm };
