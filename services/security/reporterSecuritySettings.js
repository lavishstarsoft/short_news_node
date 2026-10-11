'use strict';

/**
 * Cached access to the reporter security switches. `current()` is synchronous (for
 * middleware) and returns the last loaded values — refreshed in the background every
 * 30 s; `get()` awaits a fresh-enough copy. Any DB problem → all rules OFF (fail-safe
 * for a live app: security rules never lock people out because Mongo hiccupped).
 */
const ReporterSecuritySettings = require('../../models/ReporterSecuritySettings');

const TTL_MS = 30e3;
const DEFAULTS = Object.freeze({
  payoutLinkHold: false,
  sicSelfApprovalBlock: false,
  sicSelfApprovalWindowDays: 30,
  blockUnapprovedAppLogin: false,
  closeReporterPortal: false,
  reporterLoginRateLimit: false,
  singleDeviceLogin: false,
  singleDeviceStrict: false,
  requireGpsOnNews: false,
  minReporterAppVersion: '',
});
const FLAGS = ['payoutLinkHold', 'sicSelfApprovalBlock', 'blockUnapprovedAppLogin', 'closeReporterPortal',
  'reporterLoginRateLimit', 'singleDeviceLogin', 'singleDeviceStrict', 'requireGpsOnNews'];

let _cache = { ...DEFAULTS };
let _loadedAt = 0;
let _inflight = null;

function pick(doc) {
  const out = { ...DEFAULTS };
  if (!doc) return out;
  for (const f of FLAGS) out[f] = doc[f] === true;
  const w = Number(doc.sicSelfApprovalWindowDays);
  out.sicSelfApprovalWindowDays = Number.isFinite(w) && w >= 0 ? Math.round(w) : DEFAULTS.sicSelfApprovalWindowDays;
  out.minReporterAppVersion = typeof doc.minReporterAppVersion === 'string' ? doc.minReporterAppVersion.trim() : '';
  return out;
}

async function load() {
  if (_inflight) return _inflight;
  _inflight = ReporterSecuritySettings.findOne({ key: 'reporter_security' }).lean()
    .then((doc) => { _cache = pick(doc); _loadedAt = Date.now(); return _cache; })
    .catch(() => { _loadedAt = Date.now(); return _cache; })
    .finally(() => { _inflight = null; });
  return _inflight;
}

async function get() {
  if (Date.now() - _loadedAt < TTL_MS) return _cache;
  return load();
}

function current() {
  if (Date.now() - _loadedAt >= TTL_MS) load().catch(() => {});
  return _cache;
}

/** Super Admin update; only known keys are written. Returns the new values. */
async function update(patch, updatedBy) {
  const set = { updatedBy: String(updatedBy || '') };
  for (const f of FLAGS) if (patch && f in patch) set[f] = patch[f] === true || patch[f] === 'true';
  if (patch && 'sicSelfApprovalWindowDays' in patch) {
    const w = Math.round(Number(patch.sicSelfApprovalWindowDays));
    if (Number.isFinite(w) && w >= 0 && w <= 3650) set.sicSelfApprovalWindowDays = w;
  }
  if (patch && 'minReporterAppVersion' in patch) {
    const v = String(patch.minReporterAppVersion || '').trim();
    if (v === '' || /^\d{1,3}(\.\d{1,3}){0,3}$/.test(v)) set.minReporterAppVersion = v;
  }
  const doc = await ReporterSecuritySettings.findOneAndUpdate(
    { key: 'reporter_security' }, { $set: set }, { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  _cache = pick(doc);
  _loadedAt = Date.now();
  return _cache;
}

function _resetForTest(values) { _cache = { ...DEFAULTS, ...(values || {}) }; _loadedAt = values ? Date.now() : 0; }

module.exports = { get, current, update, DEFAULTS, FLAGS, _resetForTest };
