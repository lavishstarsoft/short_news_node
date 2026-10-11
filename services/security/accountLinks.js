'use strict';

/**
 * "One person, many reporter accounts": links between reporter accounts that share a
 * payout destination (UPI ID / bank account) or a mobile number. Used to
 *  - hold a withdrawal whose UPI / bank / mobile also belongs to another account, and
 *  - show the red "linked accounts" groups on the Reporter Security page.
 * Reporters mostly TYPE their payout details on each withdrawal (few save them), so
 * past withdrawals are matched from their stored text as well as the saved methods.
 */
const Admin = require('../../models/Admin');
const WithdrawalRequest = require('../../models/WithdrawalRequest');
const DistrictAssignmentRequest = require('../../models/DistrictAssignmentRequest');
const ReporterLoginEvent = require('../../models/ReporterLoginEvent');
const ReporterDeviceLink = require('../../models/ReporterDeviceLink');
const News = require('../../models/News');
const { clusterBySharedKeys } = require('../quizCollusionService');

const UPI_IN_TEXT = /[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}/;
const ACCT_IN_TEXT = /A\/C\s*(\d{9,18})/;
// A bare 10-digit PhonePe mobile — NOT one that is really a UPI handle (…@ybl).
const PHONEPE_IN_TEXT = /PhonePe:?\s*(?:\+?91[\s-]?)?([6-9]\d{9})(?![\d@])/i;
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Payout method / validated payload → "upi:name@ybl" | "bank:<account no>" | null. */
function payoutKey(m) {
  if (!m) return null;
  if (m.type === 'upi' && m.upiId) return 'upi:' + String(m.upiId).trim().toLowerCase();
  if (m.type === 'phonepe') {
    const ph = String(m.phoneNumber || '').replace(/\D/g, '').slice(-10);
    if (ph.length === 10) return 'phonepe:' + ph;
  }
  const acct = String(m.accountNumber || '').replace(/\D/g, '');
  if (m.type === 'bank' && acct.length >= 9) return 'bank:' + acct;
  return null;
}

/** Keys found in a withdrawal's stored text ("UPI: name@ybl", "Bank — X · A/C 1234… · IFSC …"). */
function payoutKeysFromText(text) {
  const t = String(text || '');
  const keys = [];
  const u = t.match(UPI_IN_TEXT);
  if (u) keys.push('upi:' + u[0].toLowerCase());
  const b = t.match(ACCT_IN_TEXT);
  if (b) keys.push('bank:' + b[1]);
  const p = t.match(PHONEPE_IN_TEXT);
  if (p) keys.push('phonepe:' + p[1]);
  return keys;
}

/** Last 10 digits of a mobile number, or '' (placeholders like 0000000000 ignored). */
function normMobile(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length < 10) return '';
  const m = d.slice(-10);
  return /^(\d)\1{9}$/.test(m) ? '' : m;
}

function describeKey(k) {
  if (k.startsWith('upi:')) return { kind: 'upi', label: 'UPI ' + k.slice(4) };
  if (k.startsWith('bank:')) return { kind: 'bank', label: 'Bank A/C ' + k.slice(5) };
  if (k.startsWith('phonepe:')) return { kind: 'phonepe', label: 'PhonePe ' + k.slice(8) };
  if (k.startsWith('mob:')) return { kind: 'mobile', label: 'Mobile ' + k.slice(4) };
  return { kind: 'other', label: k };
}

/**
 * Other accounts sharing [payoutKeys] or [mobile] with account [adminId].
 * @returns {{ linkedAdminIds: string[], reasons: Array<{kind,label,adminIds:string[]}> }}
 */
async function findLinksFor(adminId, { payoutKeys = [], mobile = '' } = {}) {
  const me = String(adminId);
  const reasons = [];
  for (const key of [...new Set(payoutKeys.filter(Boolean))]) {
    const or = [{ payoutKey: key }];
    const methodQuery = {};
    if (key.startsWith('upi:')) {
      const upi = key.slice(4);
      or.push({ paymentDetails: { $regex: `(^|[\\s:])${esc(upi)}(\\s|$)`, $options: 'i' } });
      methodQuery['payoutMethods.upiId'] = { $regex: `^${esc(upi)}$`, $options: 'i' };
    } else {
      const acct = key.slice(5);
      or.push({ paymentDetails: { $regex: `A/C\\s*${esc(acct)}(\\D|$)` } });
      methodQuery['payoutMethods.accountNumber'] = acct;
    }
    const [fromWithdrawals, fromMethods] = await Promise.all([
      WithdrawalRequest.distinct('adminId', { adminId: { $ne: adminId }, $or: or }),
      Admin.distinct('_id', { _id: { $ne: adminId }, ...methodQuery }),
    ]);
    const ids = [...new Set([...fromWithdrawals, ...fromMethods].map(String))].filter((x) => x !== me);
    if (ids.length) reasons.push({ ...describeKey(key), adminIds: ids });
  }
  const mob = normMobile(mobile);
  if (mob) {
    const candidates = await Admin.find({ _id: { $ne: adminId }, mobileNumber: { $regex: `${mob.slice(-4)}\\D*$` } })
      .select('_id mobileNumber').lean();
    const ids = candidates.filter((c) => normMobile(c.mobileNumber) === mob).map((c) => String(c._id)).filter((x) => x !== me);
    if (ids.length) reasons.push({ ...describeKey('mob:' + mob), adminIds: ids });
  }
  const linkedAdminIds = [...new Set(reasons.flatMap((r) => r.adminIds))];
  return { linkedAdminIds, reasons };
}

/** Groups of 2+ reporter / in-charge accounts that share a UPI, bank account or mobile. */
async function linkedGroups() {
  const accounts = await Admin.find({ role: { $in: ['editor', 'subeditor'] } })
    .select('name username role displayRole reporterTier isActive walletFrozen walletBalance mobileNumber payoutMethods assignedState assignedStates assignedDistricts createdAt createdBy createdVia lastLogin')
    .lean();
  const withdrawals = await WithdrawalRequest.find({}).select('adminId paymentDetails payoutKey amount status createdAt').lean();

  const keysOf = new Map(); // adminId → Set(keys)
  const add = (id, k) => { if (!k) return; const s = keysOf.get(id) || new Set(); s.add(k); keysOf.set(id, s); };
  const byId = new Map(accounts.map((a) => [String(a._id), a]));
  for (const a of accounts) {
    const id = String(a._id);
    const mob = normMobile(a.mobileNumber);
    if (mob) add(id, 'mob:' + mob);
    for (const m of a.payoutMethods || []) add(id, payoutKey(m));
  }
  const wStats = new Map();
  for (const w of withdrawals) {
    const id = String(w.adminId);
    if (!byId.has(id)) continue;
    for (const k of (w.payoutKey ? [w.payoutKey] : payoutKeysFromText(w.paymentDetails))) add(id, k);
    const s = wStats.get(id) || { count: 0, paid: 0 };
    s.count += 1;
    if (w.status === 'approved') s.paid += Number(w.amount) || 0;
    wStats.set(id, s);
  }

  const nodes = [...keysOf.entries()].map(([userId, set]) => ({ userId, keys: [...set] }));
  const { clusters } = clusterBySharedKeys(nodes);
  const groups = clusters.filter((c) => c.size >= 2);
  if (!groups.length) return [];

  const memberIds = groups.flatMap((g) => g.userIds);
  const [lastLogins, proposals] = await Promise.all([
    ReporterLoginEvent.aggregate([
      { $match: { adminId: { $in: memberIds.map((x) => byId.get(x)._id) }, success: true } },
      { $sort: { at: -1 } },
      { $group: { _id: '$adminId', at: { $first: '$at' }, city: { $first: '$city' }, region: { $first: '$region' }, ip: { $first: '$ip' } } },
    ]).catch(() => []),
    DistrictAssignmentRequest.find({ reporterId: { $in: memberIds }, status: { $in: ['approved', 'pending'] } })
      .select('reporterId stateInchargeId stateInchargeName tier status createdAt').sort({ createdAt: -1 }).lean().catch(() => []),
  ]);
  const loginOf = new Map(lastLogins.map((l) => [String(l._id), l]));
  const proposalOf = new Map();
  for (const p of proposals) if (!proposalOf.has(String(p.reporterId))) proposalOf.set(String(p.reporterId), p);
  const nameOf = (id) => { const a = id && byId.get(String(id)); return a ? (a.name || a.username) : ''; };

  return groups.map((g) => {
    const count = new Map();
    for (const id of g.userIds) for (const k of keysOf.get(id) || []) count.set(k, (count.get(k) || 0) + 1);
    const shared = [...count.entries()].filter(([, n]) => n >= 2).map(([k, n]) => ({ ...describeKey(k), accounts: n }));
    const strong = shared.some((s) => s.kind !== 'mobile');
    const members = g.userIds.map((id) => {
      const a = byId.get(id);
      const l = loginOf.get(id);
      const p = proposalOf.get(id);
      const w = wStats.get(id) || { count: 0, paid: 0 };
      return {
        id,
        name: a.name || a.username,
        username: a.username,
        role: a.role,
        displayRole: a.displayRole || '',
        tier: a.reporterTier || null,
        isActive: a.isActive !== false,
        walletFrozen: !!a.walletFrozen,
        walletBalance: a.walletBalance || 0,
        state: a.assignedState || (a.assignedStates || [])[0] || '',
        district: (a.assignedDistricts || [])[0] || '',
        createdAt: a.createdAt || null,
        createdBy: nameOf(a.createdBy),
        createdVia: a.createdVia || '',
        proposedBy: p ? (p.stateInchargeName || nameOf(p.stateInchargeId)) : '',
        lastLoginAt: l ? l.at : (a.lastLogin || null),
        lastLoginPlace: l ? [l.city, l.region].filter(Boolean).join(', ') : '',
        withdrawals: w.count,
        paid: w.paid,
      };
    }).sort((x, y) => new Date(x.createdAt || 0) - new Date(y.createdAt || 0));
    return { id: g.id, size: g.size, strength: strong ? 'payout' : 'mobile', shared, members };
  }).sort((a, b) => (a.strength === b.strength ? b.size - a.size : (a.strength === 'payout' ? -1 : 1)));
}

/**
 * Did State In-Charge [approverId] propose reporter [authorId] (as stringer / in-charge)
 * within the last [windowDays] days (0 = ever)? Returns the proposal or null.
 */
async function sicProposal(approverId, authorId, windowDays, now = Date.now()) {
  if (!approverId || !authorId) return null;
  const q = { stateInchargeId: approverId, reporterId: authorId };
  if (windowDays > 0) {
    const since = new Date(now - windowDays * 864e5);
    q.$or = [{ status: 'approved', reviewedAt: { $gte: since } }, { status: 'pending', createdAt: { $gte: since } }];
  } else {
    q.status = { $in: ['approved', 'pending'] };
  }
  try {
    return await DistrictAssignmentRequest.findOne(q).select('_id tier status stateInchargeName reviewedAt createdAt').lean();
  } catch (_) {
    return null;
  }
}

/**
 * RED GROUP 2 — "one phone, many accounts": reporter accounts that have been used on
 * the same physical phone (device id from the app). This is the signal that catches a
 * State In-Charge running stringer A, then B, then C from one handset, even when the
 * UPI IDs and mobile numbers are all different.
 */
async function deviceGroups({ days = 90, minAccounts = 2 } = {}) {
  const since = new Date(Date.now() - days * 864e5);
  const rows = await ReporterDeviceLink.find({ lastSeenAt: { $gte: since } })
    .select('deviceId adminId username deviceModel platform appVersion firstSeenAt lastSeenAt logins newsPosts').lean();
  if (!rows.length) return [];

  const byDevice = new Map();
  for (const r of rows) {
    const list = byDevice.get(r.deviceId) || [];
    list.push(r);
    byDevice.set(r.deviceId, list);
  }
  const shared = [...byDevice.entries()].filter(([, list]) => new Set(list.map((x) => String(x.adminId))).size >= minAccounts);
  if (!shared.length) return [];

  const ids = [...new Set(shared.flatMap(([, list]) => list.map((x) => String(x.adminId))))];
  const [accounts, proposals] = await Promise.all([
    Admin.find({ _id: { $in: ids } })
      .select('name username role displayRole reporterTier isActive walletFrozen walletBalance mobileNumber assignedState assignedStates assignedDistricts createdAt createdBy createdVia').lean(),
    DistrictAssignmentRequest.find({ reporterId: { $in: ids }, status: { $in: ['approved', 'pending'] } })
      .select('reporterId stateInchargeId stateInchargeName tier status createdAt').sort({ createdAt: -1 }).lean().catch(() => []),
  ]);
  const byId = new Map(accounts.map((a) => [String(a._id), a]));
  const proposalOf = new Map();
  for (const p of proposals) if (!proposalOf.has(String(p.reporterId))) proposalOf.set(String(p.reporterId), p);
  const nameOf = (id) => { const a = id && byId.get(String(id)); return a ? (a.name || a.username) : ''; };

  return shared.map(([deviceId, list]) => {
    const members = list
      .filter((r) => byId.has(String(r.adminId)))
      .sort((a, b) => new Date(a.firstSeenAt || 0) - new Date(b.firstSeenAt || 0))
      .map((r) => {
        const a = byId.get(String(r.adminId));
        const p = proposalOf.get(String(r.adminId));
        return {
          id: String(r.adminId),
          name: a.name || a.username,
          username: a.username,
          role: a.role,
          displayRole: a.displayRole || '',
          tier: a.reporterTier || null,
          isActive: a.isActive !== false,
          walletFrozen: !!a.walletFrozen,
          walletBalance: a.walletBalance || 0,
          state: a.assignedState || (a.assignedStates || [])[0] || '',
          district: (a.assignedDistricts || [])[0] || '',
          createdAt: a.createdAt || null,
          createdBy: nameOf(a.createdBy),
          createdVia: a.createdVia || '',
          proposedBy: p ? (p.stateInchargeName || nameOf(p.stateInchargeId)) : '',
          firstSeenAt: r.firstSeenAt,
          lastSeenAt: r.lastSeenAt,
          logins: r.logins || 0,
          newsPosts: r.newsPosts || 0,
        };
      });
    const sample = list[0] || {};
    return {
      id: 'dev_' + deviceId.slice(-8),
      deviceId,
      deviceModel: sample.deviceModel || '',
      platform: sample.platform || '',
      size: members.length,
      // Accounts used one after another on one phone (each starting as the last stops)
      // is the classic "same person, new account every term" pattern.
      sequential: isSequential(members),
      members,
    };
  }).filter((g) => g.size >= minAccounts).sort((a, b) => b.size - a.size);
}

/** Did the accounts take turns on this phone (little or no overlap)? */
function isSequential(members) {
  if (members.length < 2) return false;
  const spans = members
    .map((m) => ({ from: new Date(m.firstSeenAt || 0).getTime(), to: new Date(m.lastSeenAt || 0).getTime() }))
    .sort((a, b) => a.from - b.from);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].from < spans[i - 1].to - 864e5) return false; // more than a day of overlap
  }
  return true;
}

/**
 * RED GROUP 3 — "one reporter, many places": the same account logging in / posting from
 * places far apart (e.g. Khammam and Nalgonda) in a short window — usually two people
 * sharing one login.
 */
async function locationGroups({ hours = 24, minKm = 60 } = {}) {
  const since = new Date(Date.now() - hours * 3600e3);
  const events = await ReporterLoginEvent.find({ at: { $gte: since }, success: true, lat: { $ne: null } })
    .select('adminId username city region lat lng at deviceId deviceModel ip').sort({ at: 1 }).lean().catch(() => []);
  const news = await News.find({ 'postedFrom.lat': { $ne: null }, publishedAt: { $gte: since } })
    .select('authorId author postedFrom publishedAt title').lean().catch(() => []);

  const byAccount = new Map();
  const add = (id, point) => {
    if (!id) return;
    const list = byAccount.get(String(id)) || [];
    list.push(point);
    byAccount.set(String(id), list);
  };
  for (const e of events) {
    add(e.adminId, { kind: 'login', at: e.at, lat: e.lat, lng: e.lng, place: [e.city, e.region].filter(Boolean).join(', '), deviceId: e.deviceId || '', deviceModel: e.deviceModel || '', name: e.username });
  }
  for (const n of news) {
    const pf = n.postedFrom || {};
    add(n.authorId, { kind: 'news', at: n.publishedAt, lat: pf.lat, lng: pf.lng, place: [pf.ipCity, pf.ipRegion].filter(Boolean).join(', '), deviceId: pf.deviceId || '', deviceModel: pf.deviceModel || '', name: n.author, title: n.title });
  }

  const out = [];
  for (const [id, points] of byAccount) {
    if (points.length < 2) continue;
    points.sort((a, b) => new Date(a.at) - new Date(b.at));
    let far = null;
    for (let i = 1; i < points.length; i++) {
      const km = haversineKm(points[i - 1], points[i]);
      const mins = Math.abs(new Date(points[i].at) - new Date(points[i - 1].at)) / 60000;
      if (km >= minKm && (!far || km > far.km)) far = { km: Math.round(km), minutes: Math.round(mins), from: points[i - 1], to: points[i] };
    }
    if (far) out.push({ id: 'loc_' + id.slice(-8), adminId: id, name: points[0].name || '', points: points.length, ...far });
  }
  if (!out.length) return [];
  const accounts = await Admin.find({ _id: { $in: out.map((x) => x.adminId) } })
    .select('name username reporterTier isActive walletFrozen assignedState assignedDistricts').lean();
  const byId = new Map(accounts.map((a) => [String(a._id), a]));
  return out
    .map((x) => {
      const a = byId.get(x.adminId);
      return {
        ...x,
        name: a ? (a.name || a.username) : x.name,
        username: a ? a.username : '',
        tier: a ? a.reporterTier || null : null,
        isActive: a ? a.isActive !== false : true,
        walletFrozen: a ? !!a.walletFrozen : false,
        state: a ? a.assignedState || '' : '',
        district: a ? (a.assignedDistricts || [])[0] || '' : '',
        // Two phones in two places = probably shared login; one phone moving fast = travel.
        sameDevice: x.from.deviceId && x.to.deviceId ? x.from.deviceId === x.to.deviceId : null,
      };
    })
    .sort((a, b) => b.km - a.km);
}

/** Straight-line distance between two lat/lng points, in km. */
function haversineKm(a, b) {
  if (a.lat == null || b.lat == null) return 0;
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

module.exports = { payoutKey, payoutKeysFromText, normMobile, describeKey, findLinksFor, linkedGroups, sicProposal,
  deviceGroups, locationGroups, haversineKm, isSequential };
