'use strict';

/**
 * Records reporter APP logins (the web dashboard login keeps its own history).
 * Fire-and-forget: the login response never waits for this. IP → city uses the
 * offline geoip-lite database only (no external calls).
 *  - every attempt → ReporterLoginEvent
 *  - success → Admin.lastLogin + Admin.loginHistory (last 10), so the existing Fraud
 *    Alerts "Shared IPs" check finally sees app logins
 *  - failure → the Security Alert Engine's brute-force detector
 */
const requestIp = require('request-ip');
const geoip = require('geoip-lite');
const Admin = require('../../models/Admin');
const ReporterLoginEvent = require('../../models/ReporterLoginEvent');
const alertEngine = require('./alertEngine');

function geoOf(ip) {
  try {
    const g = ip ? geoip.lookup(String(ip).replace(/^::ffff:/, '')) : null;
    if (!g) return { city: '', region: '', country: '', lat: null, lng: null };
    return {
      city: g.city || '', region: g.region || '', country: g.country || '',
      lat: Array.isArray(g.ll) ? g.ll[0] : null, lng: Array.isArray(g.ll) ? g.ll[1] : null,
    };
  } catch (_) {
    return { city: '', region: '', country: '', lat: null, lng: null };
  }
}

function clip(v, n) { return String(v == null ? '' : v).slice(0, n); }

/** Builds the event (exported for tests). Device fields are Phase 2 (sent by newer apps). */
function buildEvent(req, { admin, username, success, reason }) {
  const ip = clip(requestIp.getClientIp(req) || req.ip || '', 64);
  const b = (req && req.body) || {};
  return {
    adminId: admin ? admin._id : null,
    username: clip(username || (admin && admin.username) || '', 120),
    role: clip(admin ? admin.role : '', 20),
    success: !!success,
    reason: clip(reason, 30),
    source: 'app',
    ip,
    ...geoOf(ip),
    userAgent: clip(req && req.headers ? req.headers['user-agent'] : '', 300),
    deviceId: clip(req && req.headers ? (req.headers['x-device-id'] || '') : '', 64).replace(/[^A-Za-z0-9-]/g, ''),
    deviceModel: clip(b.deviceModel, 80),
    appVersion: clip(b.appVersion, 30),
    at: new Date(),
  };
}

async function write(ev, admin) {
  await ReporterLoginEvent.create(ev);
  if (ev.success && admin) {
    const place = [ev.city, ev.region, ev.country].filter(Boolean).join(', ') || 'Unknown Location';
    await Admin.updateOne({ _id: admin._id }, {
      $set: { lastLogin: ev.at },
      $push: {
        loginHistory: {
          $each: [{
            ip: ev.ip, userAgent: ev.userAgent, location: `${place} (app)`,
            locationDetails: { city: ev.city, region: ev.region, country: ev.country, latitude: ev.lat, longitude: ev.lng },
            timestamp: ev.at,
          }],
          $slice: -10,
        },
      },
    });
  }
  if (!ev.success && ev.reason === 'bad_password') {
    alertEngine.record({ type: 'login_failed', ip: ev.ip, account: ev.username, endpoint: '/admin/api/reporter/login', userAgent: ev.userAgent });
  }
}

/** Never throws, never delays the caller. */
function recordAppLogin(req, info) {
  let ev;
  try { ev = buildEvent(req, info); } catch (_) { return; }
  setImmediate(() => { write(ev, info && info.admin).catch((e) => console.error('reporter login record failed:', e.message)); });
}

module.exports = { recordAppLogin, buildEvent, write, geoOf };
