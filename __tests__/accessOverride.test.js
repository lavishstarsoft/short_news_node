'use strict';

/**
 * P4 — Emergency access override: service (grant/revoke/read + IST expiry) and
 * the enforcement arithmetic (10 + activeExtraAllowed). Audit is verified.
 */

const mongoose = require('mongoose');
const { istDateKey } = require('../utils/indianDateTime');

// In-memory stand-ins for the two models the service touches.
const store = { overrides: [], audits: [] };

jest.mock('../models/ReporterAccessOverride', () => {
  const match = (row, q) =>
    Object.entries(q).every(([k, v]) => String(row[k]) === String(v));
  return {
    findOne: (q) => ({ lean: async () => store.overrides.find((r) => match(r, q)) || null }),
    findOneAndUpdate: async (q, update) => {
      let row = store.overrides.find((r) => match(r, q));
      if (!row) { row = { reporterId: q.reporterId, dateKey: q.dateKey, extraAllowed: 0 }; store.overrides.push(row); }
      if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) row[k] = (row[k] || 0) + v;
      if (update.$set) Object.assign(row, update.$set);
      return row;
    },
    updateOne: async (q, update) => {
      const row = store.overrides.find((r) => match(r, q));
      if (row && update.$set) Object.assign(row, update.$set);
      return { modifiedCount: row ? 1 : 0 };
    },
  };
});
jest.mock('../models/AuditLog', () => ({ create: async (doc) => { store.audits.push(doc); return doc; } }));

const {
  getActiveExtraAllowed,
  grantAccess,
  revokeAccess,
  MAX_EXTRA_PER_GRANT,
} = require('../utils/accessOverrideService');

const REP = new mongoose.Types.ObjectId();
const SIC = { id: new mongoose.Types.ObjectId(), name: 'SIC One', role: 'subeditor' };
const today = istDateKey(new Date());

beforeEach(() => { store.overrides = []; store.audits = []; });

describe('getActiveExtraAllowed', () => {
  test('no override → 0', async () => {
    expect(await getActiveExtraAllowed(REP)).toBe(0);
  });
  test('active override today → its extra', async () => {
    store.overrides.push({ reporterId: REP, dateKey: today, extraAllowed: 3, status: 'active' });
    expect(await getActiveExtraAllowed(REP)).toBe(3);
  });
  test('revoked override today → 0 (cap restored)', async () => {
    store.overrides.push({ reporterId: REP, dateKey: today, extraAllowed: 3, status: 'revoked' });
    expect(await getActiveExtraAllowed(REP)).toBe(0);
  });
  test('yesterday override → ignored today (auto-expiry)', async () => {
    store.overrides.push({ reporterId: REP, dateKey: '2000-01-01', extraAllowed: 5, status: 'active' });
    expect(await getActiveExtraAllowed(REP)).toBe(0);
  });
});

describe('grantAccess', () => {
  test('grants +2 today, active, audited', async () => {
    const r = await grantAccess({ reporterId: REP, reporterName: 'Rep', granter: SIC, extra: 2 });
    expect(r.ok).toBe(true);
    expect(r.extraAllowed).toBe(2);
    expect(await getActiveExtraAllowed(REP)).toBe(2);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0].action).toBe('reporter_access_grant');
  });
  test('accumulates onto the same day (+2 then +1 = 3)', async () => {
    await grantAccess({ reporterId: REP, reporterName: 'Rep', granter: SIC, extra: 2 });
    const r = await grantAccess({ reporterId: REP, reporterName: 'Rep', granter: SIC, extra: 1 });
    expect(r.extraAllowed).toBe(3);
  });
  test('extra is clamped to 1..MAX_EXTRA_PER_GRANT', async () => {
    const hi = await grantAccess({ reporterId: REP, reporterName: 'Rep', granter: SIC, extra: 999 });
    expect(hi.added).toBe(MAX_EXTRA_PER_GRANT);
    store.overrides = [];
    const lo = await grantAccess({ reporterId: REP, reporterName: 'Rep', granter: SIC, extra: 0 });
    expect(lo.added).toBe(1);
  });
});

describe('revokeAccess', () => {
  test('active override → revoked, cap restored, audited', async () => {
    await grantAccess({ reporterId: REP, reporterName: 'Rep', granter: SIC, extra: 4 });
    const r = await revokeAccess({ reporterId: REP, reporterName: 'Rep', granter: SIC });
    expect(r.ok).toBe(true);
    expect(await getActiveExtraAllowed(REP)).toBe(0);
    expect(store.audits.some((a) => a.action === 'reporter_access_revoke')).toBe(true);
  });
  test('no active override → ok:false, no audit', async () => {
    const r = await revokeAccess({ reporterId: REP, reporterName: 'Rep', granter: SIC });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('no_active_override');
    expect(store.audits).toHaveLength(0);
  });
});

describe('enforcement arithmetic (10 + activeExtraAllowed)', () => {
  const BASE = 10;
  const blocked = (submitted, extra) => submitted >= BASE + extra;
  test('no override: 10th allowed (9<10), 11th blocked (10>=10)', () => {
    expect(blocked(9, 0)).toBe(false);
    expect(blocked(10, 0)).toBe(true);
  });
  test('+2 override: 11th & 12th allowed, 13th blocked', () => {
    expect(blocked(10, 2)).toBe(false); // 11th
    expect(blocked(11, 2)).toBe(false); // 12th
    expect(blocked(12, 2)).toBe(true);  // 13th
  });
  test('revoke (extra→0) immediately re-blocks at 11th', () => {
    expect(blocked(10, 0)).toBe(true);
  });
});
