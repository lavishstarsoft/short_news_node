'use strict';

/**
 * session.js — short-lived, purpose-scoped "agreement" session.
 *
 * ISOLATED from the normal admin session:
 *  - stored in a DIFFERENT cookie (`agr_token`, not `token`),
 *  - JWT payload has `purpose:'agreement'` and NO role/permissions,
 *  - so it can never authenticate against requireAuth/requireAdmin (those read
 *    the `token` cookie and require role admin/superadmin — an agreement token
 *    carries neither), i.e. it cannot access the admin dashboard/APIs.
 */

const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../../config/secrets');

const COOKIE = 'agr_token';
const TTL_MIN = Math.max(5, parseInt(process.env.AGREEMENT_SESSION_TTL_MIN, 10) || 20);

function issue(res, { adminId, otpVerified }) {
  const token = jwt.sign(
    { purpose: 'agreement', adminId: String(adminId), otpVerified: !!otpVerified },
    getJwtSecret(),
    { expiresIn: `${TTL_MIN}m` }
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: TTL_MIN * 60 * 1000
  });
  return token;
}

function clear(res) {
  try { res.clearCookie(COOKIE); } catch (_) {}
}

/** Read + verify the agreement session; returns { adminId, otpVerified } or null. */
function read(req) {
  try {
    const raw = req.cookies && req.cookies[COOKIE];
    if (!raw) return null;
    const d = jwt.verify(raw, getJwtSecret());
    if (!d || d.purpose !== 'agreement' || !d.adminId) return null;
    return { adminId: d.adminId, otpVerified: !!d.otpVerified };
  } catch (_) { return null; }
}

/** Express guard: only a valid, OTP-verified agreement session may proceed. */
function requireAgreementSession(req, res, next) {
  const s = read(req);
  if (!s) return res.status(401).json({ error: 'Agreement session invalid or expired. Please verify again.' });
  req.agreement = s;
  next();
}

module.exports = { issue, clear, read, requireAgreementSession, COOKIE };
