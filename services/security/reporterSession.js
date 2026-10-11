'use strict';

/**
 * ONE-DEVICE LOGIN for reporters and State In-Charges.
 *
 * Every login mints a session id (`sid`) that goes into the JWT and onto the
 * account (`Admin.activeSession` for the app, `activeWebSession` for the dashboard).
 * A later login on another phone replaces it, so the old device's token no longer
 * matches and its next request gets 401 SESSION_REPLACED — the app already logs out
 * on 401. A socket event tells the old device immediately when it is connected.
 *
 * SAFETY: tokens issued before this existed carry no `sid`. While
 * `allowLegacyTokens` is true (default) those keep working, so switching the rule on
 * never logs out the people already using the live app.
 */
const crypto = require('crypto');
const Admin = require('../../models/Admin');
const ReporterDeviceLink = require('../../models/ReporterDeviceLink');
const { placeText } = require('./deviceContext');
const { ROOM } = require('../realtime/workflowEmit');

/** Roles the one-device rule applies to (reporters + State In-Charges/desk). */
const SINGLE_DEVICE_ROLES = ['editor', 'subeditor'];

const newSid = () => crypto.randomUUID();

/**
 * Save this login as the account's active APP session and return the sid.
 * Returns the sid it replaced (or null) so the caller can kick that device.
 */
async function startAppSession(admin, ctx) {
  const sid = newSid();
  const previous = (admin.activeSession && admin.activeSession.sid) || null;
  await Admin.updateOne({ _id: admin._id }, {
    $set: {
      activeSession: {
        sid,
        deviceId: ctx.deviceId || '',
        deviceModel: ctx.deviceModel || '',
        platform: ctx.platform || '',
        appVersion: ctx.appVersion || '',
        ip: ctx.ip || '',
        place: placeText(ctx),
        at: new Date(),
      },
    },
  });
  return { sid, previousSid: previous };
}

/** Same for the web dashboard (kept in its own slot). */
async function startWebSession(admin, ctx) {
  const sid = newSid();
  const previous = (admin.activeWebSession && admin.activeWebSession.sid) || null;
  await Admin.updateOne({ _id: admin._id }, {
    $set: {
      activeWebSession: { sid, ip: ctx.ip || '', place: placeText(ctx), userAgent: ctx.userAgent || '', at: new Date() },
    },
  });
  return { sid, previousSid: previous };
}

/** Remember that this account was used on this phone (for the "same phone" groups). */
async function touchDeviceLink(admin, ctx, { login = false, newsPost = false } = {}) {
  if (!ctx || !ctx.deviceId || !admin) return;
  const inc = {};
  if (login) inc.logins = 1;
  if (newsPost) inc.newsPosts = 1;
  try {
    await ReporterDeviceLink.updateOne(
      { deviceId: ctx.deviceId, adminId: admin._id || admin.id || admin },
      {
        $set: {
          username: admin.username || '',
          deviceModel: ctx.deviceModel || '',
          platform: ctx.platform || '',
          appVersion: ctx.appVersion || '',
          lastSeenAt: new Date(),
        },
        $setOnInsert: { firstSeenAt: new Date() },
        ...(Object.keys(inc).length ? { $inc: inc } : {}),
      },
      { upsert: true },
    );
  } catch (e) {
    // Best-effort bookkeeping: a duplicate-key race or a slow DB must not fail a login.
    if (e && e.code !== 11000) console.error('device link failed:', e.message);
  }
}

/**
 * Is the session in this token still the account's active one?
 * @returns {{ok:true} | {ok:false, reason:'replaced'|'no_session'}}
 */
function checkSession(decoded, latestAdmin, { enforce, allowLegacyTokens = true, web = false }) {
  if (!enforce) return { ok: true };
  if (!latestAdmin || !SINGLE_DEVICE_ROLES.includes(latestAdmin.role)) return { ok: true };
  const tokenSid = decoded && decoded.sid;
  const slot = web ? latestAdmin.activeWebSession : latestAdmin.activeSession;
  const activeSid = slot && slot.sid;
  if (!tokenSid) return allowLegacyTokens ? { ok: true } : { ok: false, reason: 'no_session' };
  if (!activeSid) return { ok: true }; // nothing recorded yet (first login after the update)
  return tokenSid === activeSid ? { ok: true } : { ok: false, reason: 'replaced' };
}

const SESSION_REPLACED = {
  code: 'SESSION_REPLACED',
  error: 'You have been logged out because this account was opened on another phone. Only one device can be logged in at a time.',
};

/**
 * Log the previous device out right away: tell it over its socket (the app compares the
 * sid with its own and signs out) and drop that socket. A device that is offline finds
 * out on its next request (401 SESSION_REPLACED).
 */
function kickPreviousDevice(io, adminId, previousSid, newCtx) {
  if (!io || !adminId || !previousSid) return;
  const payload = {
    sid: previousSid,
    reason: 'new_login',
    deviceModel: (newCtx && newCtx.deviceModel) || '',
    place: newCtx ? placeText(newCtx) : '',
    at: new Date().toISOString(),
  };
  try {
    io.to(ROOM.reporter(adminId)).emit('session_revoked', payload);
  } catch (e) {
    console.error('session kick emit failed:', e.message);
  }
  // Also disconnect it server-side, so an old app build that ignores the event
  // still stops receiving this reporter's live updates.
  Promise.resolve()
    .then(async () => {
      if (typeof io.in !== 'function') return;
      const sockets = await io.in(ROOM.reporter(adminId)).fetchSockets();
      for (const sock of sockets) {
        const sid = (sock.data && sock.data.sid) || null;
        if (sid === previousSid) sock.disconnect(true); // leave the new device connected
      }
    })
    .catch((e) => console.error('session kick disconnect failed:', e.message));
}

module.exports = {
  SINGLE_DEVICE_ROLES, SESSION_REPLACED,
  startAppSession, startWebSession, touchDeviceLink, checkSession, kickPreviousDevice, newSid,
};

/**
 * Version gate for the reporter APP only (news readers are never affected).
 * "2.0.30" >= "2.0.28" → ok. An app that sends no version is allowed while the
 * gate is on, otherwise old builds would be locked out before they can update.
 */
function appVersionTooOld(appVersion, minVersion) {
  const min = String(minVersion || '').trim();
  const cur = String(appVersion || '').trim();
  if (!min) return false;
  if (!cur) return false;
  const parts = (v) => v.split('.').map((x) => parseInt(x, 10) || 0);
  const a = parts(cur);
  const b = parts(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

module.exports.appVersionTooOld = appVersionTooOld;
