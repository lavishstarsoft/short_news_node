const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');

// Accept tokens minted for any of the configured Google client IDs (web + ios).
const ALLOWED_AUDIENCES = [
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_WEB_CLIENT_ID,
  process.env.GOOGLE_IOS_CLIENT_ID,
].filter(Boolean);

const oauthClient = new OAuth2Client();

// SECURE BY DEFAULT: unauthenticated writes are REJECTED unless explicitly disabled.
// Without a verified token the server cannot trust req.body.userId, so a client could
// otherwise impersonate any user. Only set REQUIRE_MOBILE_AUTH=false as a temporary
// escape hatch if a legacy app version (that sends no token) must be supported during
// rollout — and remove it as soon as that version is retired.
const REQUIRE_MOBILE_AUTH = process.env.REQUIRE_MOBILE_AUTH !== 'false';

function extractBearerToken(req) {
  const header = req.headers?.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  return null;
}

async function verifyGoogleIdToken(idToken) {
  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience: ALLOWED_AUDIENCES.length > 0 ? ALLOWED_AUDIENCES : undefined,
  });
  const payload = ticket.getPayload();
  return payload?.sub || null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  SCALE: in-process token + user caches (no Mongo / no RSA verify per request)
//
//  Google ID tokens are stateless JWTs valid ~1h and CANNOT be revoked before
//  expiry — so caching the verified {token → googleId} until the token's own exp
//  is exactly as safe as re-verifying every time, and removes the RSA verify from
//  the hot path. The user doc is cached briefly to avoid a Mongo round-trip on
//  every request. Both caches are per-process (ideal at 70K rps: no network hop),
//  bounded (FIFO evict) and lazily TTL-expired.
// ─────────────────────────────────────────────────────────────────────────────
function makeTtlCache(maxEntries) {
  const store = new Map();
  return {
    get(key) {
      const e = store.get(key);
      if (!e) return undefined;
      if (Date.now() >= e.exp) { store.delete(key); return undefined; }
      store.delete(key); store.set(key, e); // bump recency (LRU)
      return e.val;
    },
    set(key, val, ttlMs) {
      if (store.has(key)) store.delete(key);
      store.set(key, { val, exp: Date.now() + ttlMs });
      if (store.size > maxEntries) store.delete(store.keys().next().value); // evict oldest
    },
    delete(key) { store.delete(key); },
    get size() { return store.size; },
  };
}

const TOKEN_CACHE = makeTtlCache(Number(process.env.AUTH_TOKEN_CACHE_MAX) || 50000); // token -> googleId
const USER_CACHE = makeTtlCache(Number(process.env.AUTH_USER_CACHE_MAX) || 50000);   // googleId -> user(lean)|null
const USER_TTL_MS = (Number(process.env.AUTH_USER_CACHE_TTL_SEC) || 60) * 1000;

/** Verify (or reuse a cached) Google ID token → googleId. Caches until token exp. */
async function verifyGoogleIdTokenCached(idToken) {
  const hit = TOKEN_CACHE.get(idToken);
  if (hit) return hit;
  const ticket = await oauthClient.verifyIdToken({
    idToken,
    audience: ALLOWED_AUDIENCES.length > 0 ? ALLOWED_AUDIENCES : undefined,
  });
  const payload = ticket.getPayload();
  const googleId = payload?.sub || null;
  if (googleId) {
    // TTL = time left on the token, clamped to [60s, 60min] as a safety band.
    const remainingMs = payload.exp ? payload.exp * 1000 - Date.now() : 5 * 60 * 1000;
    TOKEN_CACHE.set(idToken, googleId, Math.max(60 * 1000, Math.min(remainingMs, 60 * 60 * 1000)));
  }
  return googleId;
}

/** Cached user lookup by googleId (lean). Caches `null` too, to absorb miss storms. */
async function getUserCached(googleId) {
  const cached = USER_CACHE.get(googleId);
  if (cached !== undefined) return cached; // includes cached null
  let user = null;
  try { user = await User.findOne({ googleId }).lean(); } catch (_) { /* non-fatal */ }
  USER_CACHE.set(googleId, user, USER_TTL_MS);
  return user;
}

/** Invalidate caches for a user (call on logout / ban / profile change if needed). */
function invalidateAuthCache({ token, googleId } = {}) {
  if (token) TOKEN_CACHE.delete(token);
  if (googleId) USER_CACHE.delete(googleId);
}

/**
 * Authenticates a mobile user via a Google ID token in the Authorization
 * header. On success, the verified Google user id is the single source of
 * truth for `userId` — clients can no longer impersonate other users by
 * putting an arbitrary id in the request body.
 *
 * Behaviour:
 *  - Valid token  -> req.verifiedGoogleId set, req.body.userId overwritten.
 *  - No token + REQUIRE_MOBILE_AUTH=false -> allowed (legacy), warning logged.
 *  - No/invalid token + REQUIRE_MOBILE_AUTH=true -> 401.
 */
async function verifyMobileUser(req, res, next) {
  const token = extractBearerToken(req);

  if (!token) {
    if (REQUIRE_MOBILE_AUTH) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    console.warn(
      `[mobileAuth] Unauthenticated write allowed (legacy mode): ${req.method} ${req.originalUrl}`
    );
    return next();
  }

  try {
    const googleId = await verifyGoogleIdTokenCached(token); // cached RSA verify
    if (!googleId) {
      throw new Error('Token payload missing subject');
    }

    req.verifiedGoogleId = googleId;
    // Verified identity wins over any client-supplied userId.
    if (req.body && typeof req.body === 'object') {
      req.body.userId = googleId;
    }

    // Cached user lookup (no Mongo hit on the hot path); never blocks on failure.
    req.authUser = await getUserCached(googleId);

    return next();
  } catch (error) {
    if (REQUIRE_MOBILE_AUTH) {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }
    console.warn(
      `[mobileAuth] Invalid token ignored (legacy mode): ${error.message}`
    );
    return next();
  }
}

module.exports = { verifyMobileUser, verifyGoogleIdToken, verifyGoogleIdTokenCached, getUserCached, invalidateAuthCache, REQUIRE_MOBILE_AUTH };
