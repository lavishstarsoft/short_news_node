'use strict';

/**
 * P4 — accessOverrideController authorization & IDOR guards.
 * Reporter can only request (notify). Grant/revoke are coverage-scoped; self-grant,
 * out-of-coverage, invalid/non-tiered targets are rejected. Super Admin unrestricted.
 */

const mongoose = require('mongoose');

const mockAdminFindById = jest.fn();
jest.mock('../models/Admin', () => ({ findById: mockAdminFindById }));

const mockNotifCreate = jest.fn().mockResolvedValue({});
jest.mock('../models/Notification', () => ({ create: mockNotifCreate }));
jest.mock('../models/ReporterAccessOverride', () => ({}));

const mockGrant = jest.fn().mockResolvedValue({ ok: true, extraAllowed: 2, added: 2, dateKey: 'd' });
const mockRevoke = jest.fn().mockResolvedValue({ ok: true, dateKey: 'd' });
const mockGetExtra = jest.fn().mockResolvedValue(0);
jest.mock('../utils/accessOverrideService', () => ({
  getActiveExtraAllowed: (...a) => mockGetExtra(...a),
  getTodayOverride: jest.fn(),
  grantAccess: (...a) => mockGrant(...a),
  revokeAccess: (...a) => mockRevoke(...a),
}));

const mockManaged = jest.fn();
const mockFindIncharge = jest.fn();
jest.mock('../utils/editorCoverageHelper', () => ({
  getManagedReporterIds: (...a) => mockManaged(...a),
  getAdminId: (d) => String((d && (d._id || d.id)) || ''),
  resolveReporterStateIncharge: async () => ({ name: 'SIC', mobileNumber: '999' }),
  findReporterStateInchargeDoc: (...a) => mockFindIncharge(...a),
}));

jest.mock('../utils/dailyLimitService', () => ({
  isTierLimited: (t) => t === 'stringer' || t === 'district_incharge',
  countReporterDailySubmissions: async () => 10,
  TIER_DAILY_LIMIT: 10,
}));

const ctrl = require('../controllers/accessOverrideController');

const REP_ID = new mongoose.Types.ObjectId();
const SUB_ID = new mongoose.Types.ObjectId();

const selStub = (doc) => ({ select: async () => doc });
function res() {
  return { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, render() { this.rendered = true; return this; }, send(s){ this.sent = s; return this; } };
}

beforeEach(() => {
  mockAdminFindById.mockReset();
  mockNotifCreate.mockClear();
  mockGrant.mockClear(); mockRevoke.mockClear();
  mockManaged.mockReset(); mockFindIncharge.mockReset();
});

describe('requestAccess (reporter only, notify-only)', () => {
  test('tiered reporter → notifies resolved State In-Charge, exposes no ids', async () => {
    mockAdminFindById.mockReturnValue(selStub({ _id: REP_ID, role: 'editor', reporterTier: 'stringer', name: 'Rep' }));
    mockFindIncharge.mockResolvedValue({ _id: SUB_ID, name: 'SIC' });
    const r = res();
    await ctrl.requestAccess({ admin: { id: String(REP_ID), role: 'editor' } }, r);
    expect(r.body.ok).toBe(true);
    expect(r.body.notified).toBe(true);
    expect(mockNotifCreate).toHaveBeenCalledTimes(1);
    expect(r.body.stateInCharge).toEqual({ name: 'SIC', mobileNumber: '999' });
    expect(JSON.stringify(r.body)).not.toContain(String(SUB_ID)); // no incharge id leaked
  });

  test('non-editor caller → 403, no notification', async () => {
    const r = res();
    await ctrl.requestAccess({ admin: { id: String(SUB_ID), role: 'subeditor' } }, r);
    expect(r.code).toBe(403);
    expect(mockNotifCreate).not.toHaveBeenCalled();
  });
});

describe('grant — authorization & IDOR guards', () => {
  const superReq = (body) => ({ admin: { id: 'super1', role: 'superadmin' }, body });

  test('invalid ObjectId reporterId → 400', async () => {
    const r = res();
    await ctrl.grant(superReq({ reporterId: 'not-an-id', extra: 2 }), r);
    expect(r.code).toBe(400);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  test('non-tiered target → 400', async () => {
    mockAdminFindById.mockReturnValue(selStub({ _id: REP_ID, role: 'editor', reporterTier: null }));
    const r = res();
    await ctrl.grant(superReq({ reporterId: String(REP_ID), extra: 2 }), r);
    expect(r.code).toBe(400);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  test('self-grant → 403', async () => {
    mockAdminFindById.mockReturnValue(selStub({ _id: SUB_ID, role: 'editor', reporterTier: 'stringer' }));
    const r = res();
    // actor id == target id
    await ctrl.grant({ admin: { id: String(SUB_ID), role: 'subeditor' }, body: { reporterId: String(SUB_ID), extra: 2 } }, r);
    expect(r.code).toBe(403);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  test('sub-editor out of coverage → 403', async () => {
    mockAdminFindById
      .mockReturnValueOnce(selStub({ _id: REP_ID, role: 'editor', reporterTier: 'stringer', name: 'Rep' })) // loadTieredReporter
      .mockReturnValueOnce(selStub({ _id: SUB_ID, role: 'subeditor', permissions: {} }));                    // granter coverage load
    mockManaged.mockResolvedValue([]); // manages nobody
    const r = res();
    await ctrl.grant({ admin: { id: String(SUB_ID), role: 'subeditor' }, body: { reporterId: String(REP_ID), extra: 2 } }, r);
    expect(r.code).toBe(403);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  test('sub-editor in coverage → grants', async () => {
    mockAdminFindById
      .mockReturnValueOnce(selStub({ _id: REP_ID, role: 'editor', reporterTier: 'stringer', name: 'Rep' }))
      .mockReturnValueOnce(selStub({ _id: SUB_ID, role: 'subeditor', permissions: {} }));
    mockManaged.mockResolvedValue([String(REP_ID)]);
    const r = res();
    await ctrl.grant({ admin: { id: String(SUB_ID), role: 'subeditor' }, body: { reporterId: String(REP_ID), extra: 2 } }, r);
    expect(mockGrant).toHaveBeenCalledTimes(1);
    expect(r.body.ok).toBe(true);
  });

  test('extra out of 1..10 → 400', async () => {
    mockAdminFindById.mockReturnValue(selStub({ _id: REP_ID, role: 'editor', reporterTier: 'stringer' }));
    const r = res();
    await ctrl.grant(superReq({ reporterId: String(REP_ID), extra: 50 }), r);
    expect(r.code).toBe(400);
    expect(mockGrant).not.toHaveBeenCalled();
  });

  test('Super Admin → grants unrestricted', async () => {
    mockAdminFindById.mockReturnValue(selStub({ _id: REP_ID, role: 'editor', reporterTier: 'district_incharge' }));
    const r = res();
    await ctrl.grant(superReq({ reporterId: String(REP_ID), extra: 5 }), r);
    expect(mockGrant).toHaveBeenCalledTimes(1);
  });
});

describe('revoke', () => {
  test('Super Admin revoke → calls service', async () => {
    mockAdminFindById.mockReturnValue(selStub({ _id: REP_ID, role: 'editor', reporterTier: 'stringer' }));
    const r = res();
    await ctrl.revoke({ admin: { id: 'super1', role: 'superadmin' }, body: { reporterId: String(REP_ID) } }, r);
    expect(mockRevoke).toHaveBeenCalledTimes(1);
    expect(r.body.ok).toBe(true);
  });
});
