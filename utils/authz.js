'use strict';

/**
 * authz.js — reusable server-side ownership/authorization helpers.
 *
 * Centralises the access rules that already exist (ad-hoc) across controllers so
 * new/refactored code has ONE source of truth and can emit consistent
 * `authorization_violation` alerts. Mirrors the current model — it does NOT invent
 * or change permissions:
 *   - admin / superadmin: full access (unchanged).
 *   - editor (reporter): own resources only (news.authorId === admin.id).
 *   - subeditor (In-Charge/Bureau): own + managed reporters' news, resolved by the
 *     existing editorCoverageHelper (district/reporter scope) — never another
 *     In-Charge's reporters.
 *
 * Adopt incrementally: replace an inline `if (news.authorId !== req.admin.id) 403`
 * with `authz.requireNewsAccess(req, res, news)`. Until adopted, behaviour is
 * identical to today.
 */

const { getManagedReporterIds } = require('./editorCoverageHelper');

function isAdmin(admin) { return !!admin && (admin.role === 'admin' || admin.role === 'superadmin'); }
function isSuperAdmin(admin) { return !!admin && admin.role === 'superadmin'; }
function idStr(v) { return v == null ? '' : String(v._id || v.id || v); }

/**
 * Can `admin` (req.admin) access a news doc? Async because sub-editor scope may
 * require resolving managed reporter ids (cached/cheap). Returns boolean.
 */
async function canAccessNews(Admin, admin, news, opts = {}) {
  if (!admin || !news) return false;
  if (isAdmin(admin)) return true;
  const authorId = idStr(news.authorId);
  const self = idStr(admin.id || admin._id);
  if (authorId && authorId === self) return true;
  if (admin.role === 'subeditor') {
    if (admin.permissions && admin.permissions.canViewAllNews) return true;
    try {
      const doc = admin._id ? admin : await Admin.findById(self).lean();
      const ids = await getManagedReporterIds(Admin, doc, opts);
      if (ids === null) return true; // canViewAllNews
      return ids.map(String).includes(authorId);
    } catch (_) { return false; }
  }
  return false;
}

/** Express guard: 401 if unauthenticated, 403 (+ alert) if not allowed. Returns true if allowed. */
async function requireNewsAccess(req, res, news, opts = {}) {
  const Admin = require('../models/Admin');
  if (!req.admin) { res.status(401).json({ error: 'Authentication required' }); return false; }
  const ok = await canAccessNews(Admin, req.admin, news, opts);
  if (!ok) {
    raiseViolation(req, 'news', idStr(news && news._id));
    res.status(403).json({ error: 'Access denied. You are not authorized for this resource.' });
    return false;
  }
  return true;
}

/** Role gate: allow only if req.admin.role is in `roles`. */
function requireRole(req, res, roles) {
  if (!req.admin) { res.status(401).json({ error: 'Authentication required' }); return false; }
  if (!roles.includes(req.admin.role)) {
    raiseViolation(req, 'role', req.admin.role);
    res.status(403).json({ error: 'Access denied.' });
    return false;
  }
  return true;
}

/** Fire an authorization_violation into the Security Alert Engine (fail-open). */
function raiseViolation(req, resourceType, resourceId) {
  try {
    require('../services/security/alertEngine').record({
      type: 'authorization_violation', severity: 'HIGH',
      ip: (require('request-ip').getClientIp(req)) || req.ip,
      endpoint: req.path, method: req.method,
      account: (req.admin && req.admin.username) || '',
      accountId: (req.admin && (req.admin._id || req.admin.id)) || null,
      userAgent: req.headers['user-agent'],
      message: `Authorization violation on ${resourceType}${resourceId ? ' ' + resourceId : ''}`,
      details: { resourceType, resourceId, role: req.admin && req.admin.role }
    });
  } catch (_) { /* ignore */ }
}

module.exports = { isAdmin, isSuperAdmin, canAccessNews, requireNewsAccess, requireRole, raiseViolation };
