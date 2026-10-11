'use strict';

/**
 * permissions.js — the Phase-0 permission CATALOG (static constants only).
 *
 * READ-ONLY / INERT: this file defines string codes. It changes NO behaviour, is
 * enforced NOWHERE, and is imported by nothing in the running application yet.
 * It exists so the (pure) permissionResolver and, later, the shadow-mode layer
 * have ONE canonical vocabulary.
 *
 * Naming: `<domain>.<action>`. Keep this list small and human-readable; do not
 * add a permission until a real route needs it.
 */

const PERMISSIONS = Object.freeze({
  // Users / staff management
  USERS_VIEW: 'users.view',
  USERS_CREATE: 'users.create',
  USERS_EDIT: 'users.edit',
  USERS_DISABLE: 'users.disable',
  USERS_DELETE: 'users.delete',
  USERS_IMPERSONATE: 'users.impersonate',

  // Editorial / news
  NEWS_VIEW: 'news.view',
  NEWS_CREATE: 'news.create',
  NEWS_EDIT: 'news.edit',
  NEWS_APPROVE: 'news.approve',
  NEWS_REJECT: 'news.reject',
  NEWS_PUBLISH: 'news.publish',

  // Field operations
  REPORTERS_VIEW: 'reporters.view',
  REPORTERS_ASSIGN: 'reporters.assign',
  ASSIGNMENTS_VIEW: 'assignments.view',
  ASSIGNMENTS_CREATE: 'assignments.create',
  ASSIGNMENTS_APPROVE: 'assignments.approve',

  // Accounts / finance
  PAYMENTS_VIEW: 'payments.view',
  PAYMENTS_ADJUST: 'payments.adjust',
  PAYMENTS_PROCESS: 'payments.process',
  PAYMENTS_APPROVE: 'payments.approve',
  PAYMENTS_REVIEW: 'payments.review',
  PAYMENTS_REVERSE: 'payments.reverse',
  PAYMENTS_EXPORT: 'payments.export',
  PAYMENTS_CONFIG: 'payments.config',
  WALLET_FREEZE: 'wallet.freeze',
  WALLET_SELF: 'wallet.self', // a reporter acting on their OWN wallet

  // Settings / system
  SETTINGS_VIEW: 'settings.view',
  SETTINGS_FINANCE: 'settings.finance',
  SETTINGS_MANAGE: 'settings.manage',

  // Reports / analytics
  REPORTS_VIEW: 'reports.view',
  REPORTS_EXPORT: 'reports.export',

  // Notifications / security / audit
  NOTIFICATIONS_SEND: 'notifications.send',
  AUDIT_VIEW: 'audit.view',
  SECURITY_VIEW: 'security.view',
});

/** Every permission code (frozen array), useful for "grant all" (super admin). */
const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

/**
 * The full OPERATIONAL set an org-wide administrator holds TODAY. Mirrors the
 * current reality that every `requireAdmin` route is reachable by admin+superadmin.
 * (Kept identical to ALL_PERMISSIONS for now — Phase 3 will carve out finer
 * super-admin-only distinctions. Documented, not accidental.)
 */
const ADMIN_PERMISSIONS = ALL_PERMISSIONS;

/** Scope kinds a permission can be evaluated against. */
const SCOPE = Object.freeze({
  GLOBAL: 'global',
  STATE: 'state',
  DISTRICT: 'district',
  REPORTERS: 'reporters',
  MANAGED: 'managed', // own + managed reporters (resolved later, with DB)
  OWN: 'own',
  NONE: 'none',
});

module.exports = { PERMISSIONS, ALL_PERMISSIONS, ADMIN_PERMISSIONS, SCOPE };
