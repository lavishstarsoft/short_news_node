'use strict';

const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config/secrets');
const { verifyGoogleIdToken, REQUIRE_MOBILE_AUTH } = require('./mobileAuth');
const { ROOM } = require('../services/realtime/workflowEmit');

function extractSocketToken(socket) {
  const authToken = socket.handshake?.auth?.token;
  if (typeof authToken === 'string' && authToken.trim()) {
    return authToken.trim();
  }

  const header = socket.handshake?.headers?.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }

  // Admin dashboard: same-origin cookie
  const cookieHeader = socket.handshake?.headers?.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
  if (match && match[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  return null;
}

function tryVerifyStaffJwt(token) {
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    if (!decoded?.id) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Socket.IO connection middleware.
 * Supports:
 *  - Admin/Reporter JWT (cookie or auth.token)
 *  - Google ID token (consumer / mobile)
 */
async function socketAuthMiddleware(socket, next) {
  const token = extractSocketToken(socket);
  socket.verifiedUserId = null;
  socket.staff = null;

  if (!token) {
    return next();
  }

  const staff = tryVerifyStaffJwt(token);
  if (staff) {
    socket.staff = {
      id: String(staff.id),
      role: staff.role || 'editor',
      permissions: staff.permissions || {},
    };
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
    socket.verifiedUserId = null;
    return next();
  }
}

function joinWorkflowRooms(socket) {
  if (socket.staff?.id) {
    const role = socket.staff.role;
    if (role === 'editor') {
      socket.join(ROOM.reporter(socket.staff.id));
    } else if (
      role === 'admin' ||
      role === 'superadmin' ||
      role === 'subeditor'
    ) {
      socket.join(ROOM.admin);
      // Sub Editors also act as reporters and have their own news in AI queue
      if (role === 'subeditor') {
        socket.join(ROOM.reporter(socket.staff.id));
      }
    }
  }

  if (socket.verifiedUserId) {
    socket.join(ROOM.consumers);
  }
}

function assertSocketUserId(socket, claimedUserId) {
  if (!claimedUserId || typeof claimedUserId !== 'string') {
    return false;
  }

  if (socket.verifiedUserId) {
    return socket.verifiedUserId === claimedUserId;
  }

  if (socket.staff?.id) {
    return socket.staff.id === claimedUserId;
  }

  if (REQUIRE_MOBILE_AUTH) {
    return claimedUserId === 'anonymous_user';
  }

  return true;
}

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

  if (socket.staff?.id) {
    return { ok: true, userId: socket.staff.id };
  }

  if (REQUIRE_MOBILE_AUTH && requested !== 'anonymous_user') {
    return { ok: false, error: 'Authentication required to register userId' };
  }

  return { ok: true, userId: requested };
}

module.exports = {
  socketAuthMiddleware,
  joinWorkflowRooms,
  assertSocketUserId,
  resolveRegisterUserId,
};
