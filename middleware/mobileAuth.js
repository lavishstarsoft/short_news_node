const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');

// Accept tokens minted for any of the configured Google client IDs (web + ios).
const ALLOWED_AUDIENCES = [
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_WEB_CLIENT_ID,
  process.env.GOOGLE_IOS_CLIENT_ID,
].filter(Boolean);

const oauthClient = new OAuth2Client();

// Transition flag: while the old app (which sends no token) is still in the
// wild, leave this 'false' so existing users are not broken. Once the updated
// app that sends an Authorization: Bearer <idToken> header is widely rolled
// out, set REQUIRE_MOBILE_AUTH=true to reject unauthenticated writes.
const REQUIRE_MOBILE_AUTH = process.env.REQUIRE_MOBILE_AUTH === 'true';

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
    const googleId = await verifyGoogleIdToken(token);
    if (!googleId) {
      throw new Error('Token payload missing subject');
    }

    req.verifiedGoogleId = googleId;
    // Verified identity wins over any client-supplied userId.
    if (req.body && typeof req.body === 'object') {
      req.body.userId = googleId;
    }

    // Optionally ensure the user exists; do not block if lookup fails.
    try {
      req.authUser = await User.findOne({ googleId });
    } catch (_) {
      /* non-fatal */
    }

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

module.exports = { verifyMobileUser, verifyGoogleIdToken, REQUIRE_MOBILE_AUTH };
