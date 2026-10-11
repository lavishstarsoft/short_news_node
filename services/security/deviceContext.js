'use strict';

/**
 * What phone / place a reporter request came from — read from the REQUEST only
 * (headers + explicitly named body fields), never trusted from a story body.
 *
 * Older app versions send nothing here; every field is optional and a missing
 * value must never break a request.
 */
const requestIp = require('request-ip');
const geoip = require('geoip-lite');

const DEVICE_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

/** Sanitised device id from the X-Device-Id header (or body), '' when absent/bogus. */
function deviceIdOf(req) {
  const raw = clip((req && req.headers && req.headers['x-device-id']) || (req && req.body && req.body.deviceId), 64);
  return DEVICE_ID_RE.test(raw) ? raw : '';
}

function ipOf(req) {
  try {
    return clip(requestIp.getClientIp(req) || (req && req.ip) || '', 64);
  } catch (_) {
    return '';
  }
}

/** Offline IP → city/region (geoip-lite; no external call). */
function ipPlace(ip) {
  try {
    const g = ip ? geoip.lookup(String(ip).replace(/^::ffff:/, '')) : null;
    return g ? { city: g.city || '', region: g.region || '', country: g.country || '' } : { city: '', region: '', country: '' };
  } catch (_) {
    return { city: '', region: '', country: '' };
  }
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * GPS the phone sent with this request: { lat, lng, accuracy, at, mock } or null.
 * Accepts `gps: {lat,lng,...}` or flat lat/lng fields. Out-of-range values are dropped.
 */
function gpsOf(req) {
  const b = (req && req.body) || {};
  const g = (b.gps && typeof b.gps === 'object') ? b.gps : b;
  const lat = num(g.lat != null ? g.lat : g.latitude);
  const lng = num(g.lng != null ? g.lng : g.longitude);
  if (lat == null || lng == null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (lat === 0 && lng === 0) return null; // "null island" = no fix
  const at = g.gpsAt || g.at;
  const parsed = at ? new Date(at) : null;
  return {
    lat,
    lng,
    accuracy: num(g.accuracy),
    at: parsed && !isNaN(parsed.getTime()) ? parsed : new Date(),
    mock: g.mock === true || g.mock === 'true' || g.isMocked === true || g.isMocked === 'true',
  };
}

/** Everything about the caller's phone + network, for login / news stamping. */
function deviceContext(req) {
  const b = (req && req.body) || {};
  const h = (req && req.headers) || {};
  const ip = ipOf(req);
  const place = ipPlace(ip);
  return {
    deviceId: deviceIdOf(req),
    deviceModel: clip(b.deviceModel || h['x-device-model'], 80),
    platform: clip(b.platform || h['x-platform'], 20).toLowerCase(),
    appVersion: clip(b.appVersion || h['x-app-version'], 30),
    appSource: clip(h['x-app-source'], 40),
    userAgent: clip(h['user-agent'], 300),
    ip,
    ipCity: place.city,
    ipRegion: place.region,
    ipCountry: place.country,
    gps: gpsOf(req),
  };
}

/** "Khammam, TG" from an IP lookup (or ''). */
const placeText = (ctx) => [ctx.ipCity, ctx.ipRegion].filter(Boolean).join(', ');

module.exports = { deviceContext, deviceIdOf, ipOf, ipPlace, gpsOf, placeText, DEVICE_ID_RE };
