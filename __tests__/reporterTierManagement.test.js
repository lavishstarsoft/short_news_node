'use strict';

/**
 * P5 — Super Admin tier assignment via updateEditor / registerEditor.
 * Verifies: Super Admin can set/change/clear reporterTier, non-super-admin cannot,
 * value maps to the reporterTier enum (null for Normal), displayRole is never
 * touched by tier logic, and every tier change writes an AuditLog before→after.
 */

const mongoose = require('mongoose');

// ── Mocks ───────────────────────────────────────────────────────────────────
const store = { admins: {}, audits: [] };

function makeDoc(init) {
  const d = Object.assign({ save: async function () { store.admins[String(this._id)] = this; return this; } }, init);
  return d;
}

const mockFindById = jest.fn();
const mockFindOne = jest.fn().mockResolvedValue(null);
jest.mock('../models/Admin', () => {
  const Ctor = jest.fn(function (props) { Object.assign(this, props); this._id = props._id || new (require('mongoose').Types.ObjectId)(); this.save = async () => this; });
  Ctor.findById = (...a) => mockFindById(...a);
  Ctor.findOne = (...a) => mockFindOne(...a);
  Ctor.find = () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) });
  return Ctor;
});
jest.mock('../models/AuditLog', () => ({ create: async (doc) => { store.audits.push(doc); return doc; } }));

// Keep unrelated updateEditor dependencies inert.
jest.mock('node-fetch', () => jest.fn());
jest.mock('../config/redis', () => ({ redisClient: {}, isRedisAvailable: () => false }));
jest.mock('../services/oneSignalService', () => ({}));
jest.mock('../middleware/cache', () => ({ clearCache: jest.fn() }));

const adminController = require('../controllers/adminController');

function res() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

const ACTOR_SUPER = new mongoose.Types.ObjectId();
const ACTOR_ADMIN = new mongoose.Types.ObjectId();
const TARGET = new mongoose.Types.ObjectId();

function setup({ actorRole, targetTier }) {
  store.audits = [];
  const actor = makeDoc({ _id: actorRole === 'superadmin' ? ACTOR_SUPER : ACTOR_ADMIN, role: actorRole, username: 'actor' });
  const target = makeDoc({ _id: TARGET, role: 'editor', username: 'rep', displayRole: 'GDR Reporter', reporterTier: targetTier === undefined ? null : targetTier });
  mockFindById.mockImplementation((id) => {
    const sid = String(id);
    if (sid === String(actor._id)) return Promise.resolve(actor);
    if (sid === String(target._id)) return Promise.resolve(target);
    return Promise.resolve(null);
  });
  return { actor, target };
}

async function callUpdate(actorRole, body, targetTier) {
  const { target } = setup({ actorRole, targetTier });
  const r = res();
  await adminController.updateEditor({ admin: { id: String(actorRole === 'superadmin' ? ACTOR_SUPER : ACTOR_ADMIN) }, params: { id: String(TARGET) }, body }, r);
  return { r, target };
}

describe('updateEditor — reporterTier (Super Admin only)', () => {
  test('Super Admin sets Stringer', async () => {
    const { target } = await callUpdate('superadmin', { reporterTier: 'stringer' }, null);
    expect(target.reporterTier).toBe('stringer');
    expect(store.audits.some(a => a.action === 'reporter_tier_change' && a.before.reporterTier === null && a.after.reporterTier === 'stringer')).toBe(true);
  });

  test('Super Admin sets District In-Charge', async () => {
    const { target } = await callUpdate('superadmin', { reporterTier: 'district_incharge' }, null);
    expect(target.reporterTier).toBe('district_incharge');
  });

  test('Change Stringer → District In-Charge audited before→after', async () => {
    const { target } = await callUpdate('superadmin', { reporterTier: 'district_incharge' }, 'stringer');
    expect(target.reporterTier).toBe('district_incharge');
    const a = store.audits.find(x => x.action === 'reporter_tier_change');
    expect(a.before.reporterTier).toBe('stringer');
    expect(a.after.reporterTier).toBe('district_incharge');
  });

  test('Normal Reporter (empty / normal) stores null', async () => {
    const { target } = await callUpdate('superadmin', { reporterTier: '' }, 'stringer');
    expect(target.reporterTier).toBeNull();
    const a = store.audits.find(x => x.action === 'reporter_tier_change');
    expect(a.after.reporterTier).toBeNull();
  });

  test('displayRole is not affected by tier changes', async () => {
    const { target } = await callUpdate('superadmin', { reporterTier: 'stringer' }, null);
    expect(target.displayRole).toBe('GDR Reporter');
  });

  test('Non-super-admin cannot change tier (silently ignored, no audit)', async () => {
    const { target } = await callUpdate('admin', { reporterTier: 'stringer' }, null);
    expect(target.reporterTier).toBeNull();
    expect(store.audits.some(a => a.action === 'reporter_tier_change')).toBe(false);
  });

  test('No audit when tier unchanged (idempotent)', async () => {
    const { target } = await callUpdate('superadmin', { reporterTier: 'stringer' }, 'stringer');
    expect(target.reporterTier).toBe('stringer');
    expect(store.audits.some(a => a.action === 'reporter_tier_change')).toBe(false);
  });

  test('Invalid tier value → coerced to null', async () => {
    const { target } = await callUpdate('superadmin', { reporterTier: 'hacker_tier' }, 'stringer');
    expect(target.reporterTier).toBeNull();
  });
});

// Member Type selector → the exact (role, reporterTier, displayRole) payloads the
// hybrid UI emits. Reporter types omit displayRole (preserve existing); Sub-Editor
// sends its designation. Backend must persist them and never auto-overwrite.
describe('Member Type payload contract (hybrid UI)', () => {
  test('Reporter → reporterTier null, displayRole omitted → preserved', async () => {
    const { target } = await callUpdate('superadmin', { reporterTier: '' }, 'stringer');
    expect(target.reporterTier).toBeNull();
    expect(target.displayRole).toBe('GDR Reporter'); // untouched
  });

  test('Stringer → reporterTier stringer, displayRole preserved', async () => {
    const { target } = await callUpdate('superadmin', { reporterTier: 'stringer' }, null);
    expect(target.reporterTier).toBe('stringer');
    expect(target.displayRole).toBe('GDR Reporter');
  });

  test('District In-Charge → reporterTier district_incharge, displayRole preserved', async () => {
    const { target } = await callUpdate('superadmin', { reporterTier: 'district_incharge' }, null);
    expect(target.reporterTier).toBe('district_incharge');
    expect(target.displayRole).toBe('GDR Reporter');
  });

  test('Sub-Editor → displayRole "Sub Editor" (space) stored exactly', async () => {
    const { target } = await callUpdate('superadmin', { role: 'subeditor', reporterTier: '', displayRole: 'Sub Editor' }, null);
    expect(target.displayRole).toBe('Sub Editor');
    expect(target.reporterTier).toBeNull();
  });

  test('Sub-Editor designations Bureau / State In-Charge stored', async () => {
    let r = await callUpdate('superadmin', { role: 'subeditor', displayRole: 'Bureau' }, null);
    expect(r.target.displayRole).toBe('Bureau');
    r = await callUpdate('superadmin', { role: 'subeditor', displayRole: 'State In-Charge' }, null);
    expect(r.target.displayRole).toBe('State In-Charge');
  });

  test('Editing a member without displayRole never overwrites it', async () => {
    const { target } = await callUpdate('admin', { name: 'Renamed' }, 'stringer');
    expect(target.displayRole).toBe('GDR Reporter'); // preserved
  });
});
