'use strict';

/**
 * authorize.js — Phase-0 Step-3 SHADOW-MODE authorization middleware.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ABSOLUTE RULE: this middleware NEVER enforces. It never denies, never     │
 * │ returns 403, never redirects, never mutates req/res. It only CALCULATES a │
 * │ decision (via the pure Step-1 resolver) and, when shadow mode is ON and   │
 * │ the calculation disagrees with the (authoritative) existing guard,        │
 * │ records one compact AuthShadowLog row. It ALWAYS calls next().            │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Placement contract: mount AFTER the existing guard (requireAdmin / requireAuth),
 * so reaching this middleware means the OLD system already ALLOWED the request.
 * That lets us observe old=ALLOW honestly. We cannot observe old=DENY (those
 * requests are 403'd upstream and never arrive) — those are simply not recorded.
 *
 * Feature flag: process.env.AUTH_SHADOW_MODE === 'true'. Default OFF → the mw is a
 * single boolean check + next() (zero DB, zero resolver, zero log).
 */

const { resolve } = require('../utils/permissionResolver');

function shadowEnabled() {
  return process.env.AUTH_SHADOW_MODE === 'true';
}

/** Fire-and-forget shadow record. Never throws, never blocks the request. */
function recordShadow(req, { permission, requiredScope, newDecision, comparison }) {
  try {
    const AuthShadowLog = require('../models/AuthShadowLog');
    const admin = (req && req.admin) || {};
    // Route PATTERN only (no ids, no query string) → no PII / no secrets.
    const pattern = (req && req.route && req.route.path) || (req && req.path) || '';
    const base = (req && req.baseUrl) || '';
    AuthShadowLog.create({
      userId: admin.id || admin._id || null,
      role: admin.role || '',
      route: (base + pattern) || '',
      method: (req && req.method) || '',
      permission: permission || '',
      requiredScope: requiredScope || '',
      newDecision,
      comparison,
    }).catch(() => { /* swallow: shadow logging must never affect the request */ });
  } catch (_) {
    /* never throw */
  }
}

/**
 * requirePermission(permission, opts)
 * @param {string} permission - a code from constants/permissions
 * @param {object} [opts]
 * @param {string} [opts.scope]     - required scope descriptor (recorded, NOT evaluated here)
 * @param {string} [opts.observed]  - 'admin' (default): the preceding guard authorized
 *                                    (old=ALLOW observable). 'auth': authorization is
 *                                    decided later inside the controller → old decision
 *                                    is NOT observable here → comparisons become UNKNOWN.
 */
function requirePermission(permission, opts = {}) {
  return function shadowAuthorize(req, res, next) {
    // Flag OFF → total no-op (default in production).
    if (!shadowEnabled()) return next();

    try {
      const admin = req && req.admin;
      let newDecision;
      let comparison;

      if (!admin) {
        newDecision = 'UNKNOWN';
        comparison = 'UNKNOWN';
      } else {
        const eff = resolve(admin); // pure, no DB
        newDecision = eff.permissions.includes(permission) ? 'ALLOW' : 'DENY';
        if (opts.observed === 'auth') {
          // Real authz happens later in the controller — cannot confirm the old result.
          comparison = 'UNKNOWN';
        } else {
          // We only got here because the existing guard ALLOWED the request.
          comparison = newDecision === 'ALLOW' ? 'MATCH' : 'MISMATCH';
        }
      }

      // Only record signal (mismatch/unknown) — MATCHes are the silent norm.
      if (comparison !== 'MATCH') {
        recordShadow(req, { permission, requiredScope: opts.scope || '', newDecision, comparison });
      }
    } catch (_) {
      // Any error in the shadow path is swallowed — the request must be unaffected.
    }

    return next(); // ALWAYS continue. Never enforce.
  };
}

/**
 * requireScope(scopeType) — shadow companion. Records the scope requirement for
 * later analysis but performs NO evaluation (scope resolution needs DB and belongs
 * to a future enforcement layer). Non-enforcing; always calls next().
 */
function requireScope(scopeType) {
  return function shadowScope(req, res, next) {
    if (!shadowEnabled()) return next();
    try {
      const admin = req && req.admin;
      const eff = admin ? resolve(admin) : null;
      const userScope = eff ? eff.scope.type : 'unknown';
      // Record only when the user's scope type is narrower than / differs from required.
      if (userScope !== 'global' && userScope !== scopeType) {
        recordShadow(req, {
          permission: `scope:${scopeType}`,
          requiredScope: scopeType,
          newDecision: 'UNKNOWN',
          comparison: 'UNKNOWN',
        });
      }
    } catch (_) { /* swallow */ }
    return next();
  };
}

module.exports = { requirePermission, requireScope, shadowEnabled };
