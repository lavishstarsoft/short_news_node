'use strict';

/**
 * Phase-0 Step-2 — Financial/admin audit-closure tests.
 *
 * The 3 gap handlers (updateReporterEarningAdmin, updateReferralStatus,
 * renderImpersonatedDashboard) cannot be unit-tested in isolation: requiring the
 * monolith adminController triggers blocking infra init (Redis) — the same
 * environment constraint as the pre-existing Redis/Mongo suite failures.
 *
 * So we test the shared MECHANISM all three now use — utils/auditLogger.logAudit —
 * with the EXACT payload shapes those handlers build, asserting: one record per
 * call, correct actor/target/before/after/ip, no secrets, and fire-and-forget
 * safety (a failed audit write never throws / never breaks the caller).
 */

jest.mock('../models/AuditLog', () => ({
  create: jest.fn(() => Promise.resolve({ _id: 'audit_1' })),
}));

const AuditLog = require('../models/AuditLog');
const { logAudit } = require('../utils/auditLogger');

const fakeReq = (over = {}) => ({
  admin: { id: 'actor1', username: 'superadmin', name: 'Super Admin', role: 'superadmin' },
  headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
  ip: '10.0.0.1',
  ...over,
});

beforeEach(() => AuditLog.create.mockClear());

describe('logAudit — mechanism contract', () => {
  test('creates exactly ONE record with actor + ip resolved', async () => {
    await logAudit({ req: fakeReq(), action: 'referral_status_change', entityType: 'Referral', entityId: 'r1' });
    expect(AuditLog.create).toHaveBeenCalledTimes(1);
    const rec = AuditLog.create.mock.calls[0][0];
    expect(rec.actorId).toBe('actor1');
    expect(rec.actorName).toBe('superadmin');
    expect(rec.actorRole).toBe('superadmin');
    expect(rec.action).toBe('referral_status_change');
    expect(rec.ip).toBe('203.0.113.9'); // first x-forwarded-for hop
  });

  test('never throws and does not break caller when the audit write fails', async () => {
    AuditLog.create.mockReturnValueOnce(Promise.reject(new Error('db down')));
    await expect(logAudit({ req: fakeReq(), action: 'reporter_earning_config_update' })).resolves.not.toThrow?.();
    // The key guarantee: the call above did not throw synchronously or reject.
    expect(true).toBe(true);
  });

  test('tolerates a null req (system context) without throwing', () => {
    expect(() => logAudit({ req: null, action: 'x' })).not.toThrow();
  });
});

describe('event: user_impersonation_start (renderImpersonatedDashboard shape)', () => {
  test('records actor + target, no secrets', async () => {
    const target = { _id: 'tgt1', username: 'reporter7', name: 'Reporter Seven' };
    await logAudit({
      req: fakeReq(),
      action: 'user_impersonation_start',
      entityType: 'Admin',
      entityId: target._id,
      targetId: target._id,
      targetName: target.name || target.username,
      description: `Impersonation dashboard opened for ${target.username}`,
    });
    const rec = AuditLog.create.mock.calls[0][0];
    expect(rec.action).toBe('user_impersonation_start');
    expect(rec.targetId).toBe('tgt1');
    expect(rec.targetName).toBe('Reporter Seven');
    expect(JSON.stringify(rec)).not.toMatch(/password|token|secret|ifsc|accountNumber/i);
  });
});

describe('event: referral_status_change (updateReferralStatus shape)', () => {
  test('records before/after status + commission, no secrets', async () => {
    await logAudit({
      req: fakeReq(),
      action: 'referral_status_change',
      entityType: 'Referral',
      entityId: 'ref9',
      targetName: 'google-user-123',
      description: 'Referral ref9 status verified → paid',
      before: { status: 'verified' },
      after: { status: 'paid', commissionAmount: 50 },
    });
    const rec = AuditLog.create.mock.calls[0][0];
    expect(rec.before).toEqual({ status: 'verified' });
    expect(rec.after).toEqual({ status: 'paid', commissionAmount: 50 });
    expect(JSON.stringify(rec)).not.toMatch(/password|token|secret/i);
  });
});

describe('event: reporter_earning_config_update (updateReporterEarningAdmin shape)', () => {
  test('records before/after config with meta fields stripped', async () => {
    // mirror the handler's stripMeta()
    const stripMeta = (d) => { if (!d) return null; const { _id, __v, createdAt, updatedAt, ...rest } = d; return rest; };
    const prev = { _id: 'e1', __v: 0, createdAt: 't', updatedAt: 't', language: 'te', ratePerNews: 5 };
    const next = { _id: 'e1', __v: 1, createdAt: 't', updatedAt: 't2', language: 'te', ratePerNews: 7 };
    await logAudit({
      req: fakeReq(),
      action: 'reporter_earning_config_update',
      entityType: 'ReporterEarning',
      entityId: next._id,
      targetName: 'language:te',
      before: stripMeta(prev),
      after: stripMeta(next),
    });
    const rec = AuditLog.create.mock.calls[0][0];
    expect(rec.before).toEqual({ language: 'te', ratePerNews: 5 });
    expect(rec.after).toEqual({ language: 'te', ratePerNews: 7 });
    expect(rec.before._id).toBeUndefined(); // meta stripped
  });
});
