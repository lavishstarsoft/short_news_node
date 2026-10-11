'use strict';

/**
 * Resolve WHICH user a mobile request is about, as a Mongo filter.
 *
 * Mobile users carry two kinds of ids:
 *   • Mongo `_id`  — 24 hex chars (e.g. 65a0f3b2…)
 *   • Google id    — the token `sub`, a 21-digit number (e.g. 115806710826496439329)
 *
 * `verifyMobileUser` overwrites `req.body.userId` with the GOOGLE id and sets
 * `req.authUser` from a cache that may legitimately be null (brand-new user,
 * cache miss). Routes that then did `User.findById(userId)` cast the Google id
 * to ObjectId and crashed with a BSONError. This helper picks the right field.
 *
 * Priority (most trusted first):
 *   1. req.authUser._id        — user already resolved by the middleware
 *   2. req.verifiedGoogleId    — identity proven by the token
 *   3. req.body.userId         — client-supplied (legacy no-token mode only)
 *
 * @returns {{_id: string}|{googleId: string}|null}  null = nothing usable.
 */
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const GOOGLE_ID_RE = /^\d{10,30}$/;

function classifyUserId(raw) {
  const id = raw == null ? '' : String(raw).trim();
  if (!id) return null;
  if (OBJECT_ID_RE.test(id)) return { _id: id };
  if (GOOGLE_ID_RE.test(id)) return { googleId: id };
  return { invalid: id };
}

function resolveUserFilter({ authUser, verifiedGoogleId, bodyUserId } = {}) {
  if (authUser && authUser._id) return { _id: String(authUser._id) };
  if (verifiedGoogleId) return { googleId: String(verifiedGoogleId) };
  const c = classifyUserId(bodyUserId);
  if (!c || c.invalid) return c ? { invalid: c.invalid } : null;
  return c;
}

module.exports = { resolveUserFilter, classifyUserId, OBJECT_ID_RE, GOOGLE_ID_RE };
