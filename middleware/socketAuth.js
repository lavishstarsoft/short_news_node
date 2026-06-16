const { verifyGoogleIdToken, REQUIRE_MOBILE_AUTH } = require('./mobileAuth');

function extractSocketToken(socket) {
  const authToken = socket.handshake?.auth?.token;
  if (typeof authToken === 'string' && authToken.trim()) {
    return authToken.trim();
  }

  const header = socket.handshake?.headers?.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }

  return null;
}

/**
 * Socket.IO connection middleware — verifies Google ID token from the
 * handshake (auth.token or Authorization header), same as REST mobileAuth.
 */
async function socketAuthMiddleware(socket, next) {
  const token = extractSocketToken(socket);

  if (!token) {
    socket.verifiedUserId = null;
    return next();
  }

  try {
    const googleId = await verifyGoogleIdToken(token);
    if (!googleId) {
      throw new Error('Token payload missing subject');
    }
    socket.verifiedUserId = googleId;
    return next();
  } catch (error) {
    if (REQUIRE_MOBILE_AUTH) {
      return next(new Error('Invalid authentication token'));
    }
    console.warn(
      `[socketAuth] Invalid token ignored (legacy mode): ${error.message}`
    );
    socket.verifiedUserId = null;
    return next();
  }
}

/**
 * Validates a client-supplied userId against the verified socket identity.
 */
function assertSocketUserId(socket, claimedUserId) {
  if (!claimedUserId || typeof claimedUserId !== 'string') {
    return false;
  }

  if (socket.verifiedUserId) {
    return socket.verifiedUserId === claimedUserId;
  }

  if (REQUIRE_MOBILE_AUTH) {
    return claimedUserId === 'anonymous_user';
  }

  return true;
}

/**
 * Resolves the user id stored for this socket on `register`.
 * Verified tokens always win over client-supplied ids.
 */
function resolveRegisterUserId(socket, registeredUserId) {
  const requested =
    typeof registeredUserId === 'string' && registeredUserId.trim()
      ? registeredUserId.trim()
      : 'anonymous_user';

  if (socket.verifiedUserId) {
    if (requested !== 'anonymous_user' && requested !== socket.verifiedUserId) {
      return {
        ok: false,
        error: 'Registered userId does not match authenticated identity',
      };
    }
    return { ok: true, userId: socket.verifiedUserId };
  }

  if (REQUIRE_MOBILE_AUTH && requested !== 'anonymous_user') {
    return { ok: false, error: 'Authentication required to register userId' };
  }

  return { ok: true, userId: requested };
}

module.exports = {
  socketAuthMiddleware,
  assertSocketUserId,
  resolveRegisterUserId,
};
