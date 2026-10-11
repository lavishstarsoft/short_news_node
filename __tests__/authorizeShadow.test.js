'use strict';

/**
 * Phase-0 Step-3 — SHADOW authorization middleware tests.
 *
 * Proves the ABSOLUTE rule: the middleware never enforces (never 403s, never
 * blocks), always calls next(), fails safe, and only records non-MATCH signals
 * to the dedicated capped log — controlled by an off-by-default feature flag.
 */

jest.mock('../models/AuthShadowLog', () => ({
  create: jest.fn(() => Promise.resolve({ _id: 'shadow1' })),
}));

const AuthShadowLog = require('../models/AuthShadowLog');
const authorize = require('../middleware/authorize');

const makeReq = (admin, over = {}) => ({
  admin,
  method: 'POST',
  baseUrl: '/admin',
  route: { path: '/api/wallet-adjustment' },
  path: '/admin/api/wallet-adjustment',
  ...over,
});
const makeRes = () => {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  res.send = jest.fn(() => res);
  res.redirect = jest.fn(() => res);
  return res;
};

const ON = () => { process.env.AUTH_SHADOW_MODE = 'true'; };
const OFF = () => { delete process.env.AUTH_SHADOW_MODE; };

beforeEach(() => { AuthShadowLog.create.mockClear(); OFF(); });
afterAll(() => OFF());

describe('flag OFF (default) — total no-op', () => {
  test('calls next(), writes nothing, never touches res', () => {
    const next = jest.fn();
    const res = makeRes();
    authorize.requirePermission('payments.adjust')(makeReq({ role: 'superadmin' }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(AuthShadowLog.create).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('flag ON — MATCH (super admin)', () => {
  test('new=ALLOW → MATCH → no log, next() called, no 403', () => {
    ON();
    const next = jest.fn();
    const res = makeRes();
    authorize.requirePermission('payments.adjust')(makeReq({ role: 'superadmin' }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(AuthShadowLog.create).not.toHaveBeenCalled(); // MATCH is the silent norm
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('flag ON — MISMATCH (existing ALLOW + new DENY) MUST NOT block', () => {
  test('sub-editor lacking finance perm → DENY/MISMATCH → logged once, still next(), never 403', () => {
    ON();
    const next = jest.fn();
    const res = makeRes();
    authorize.requirePermission('payments.adjust')(
      makeReq({ id: 'u1', role: 'subeditor', permissions: { canAccessAdminDashboard: true } }),
      res, next
    );
    expect(next).toHaveBeenCalledTimes(1);           // request continues
    expect(res.status).not.toHaveBeenCalled();        // NO 403
    expect(AuthShadowLog.create).toHaveBeenCalledTimes(1); // exactly one record
    const rec = AuthShadowLog.create.mock.calls[0][0];
    expect(rec.newDecision).toBe('DENY');
    expect(rec.comparison).toBe('MISMATCH');
    expect(rec.route).toBe('/admin/api/wallet-adjustment'); // PATTERN, not a real id/query
    expect(rec.permission).toBe('payments.adjust');
    expect(rec.role).toBe('subeditor');
  });

  test('reporter hitting a finance route → DENY/MISMATCH, still next()', () => {
    ON();
    const next = jest.fn();
    authorize.requirePermission('payments.process')(makeReq({ id: 'r1', role: 'editor' }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(AuthShadowLog.create.mock.calls[0][0].comparison).toBe('MISMATCH');
  });
});

describe('flag ON — UNKNOWN cases', () => {
  test('no req.admin → UNKNOWN, next() still called', () => {
    ON();
    const next = jest.fn();
    authorize.requirePermission('payments.adjust')(makeReq(undefined), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(AuthShadowLog.create.mock.calls[0][0].comparison).toBe('UNKNOWN');
  });

  test("observed:'auth' route → comparison UNKNOWN even when new=DENY (old decided in controller)", () => {
    ON();
    const next = jest.fn();
    authorize.requirePermission('users.edit', { observed: 'auth' })(
      makeReq({ id: 'u1', role: 'subeditor' }, { route: { path: '/editors/:id' } }),
      makeRes(), next
    );
    expect(next).toHaveBeenCalledTimes(1);
    const rec = AuthShadowLog.create.mock.calls[0][0];
    expect(rec.newDecision).toBe('DENY');
    expect(rec.comparison).toBe('UNKNOWN'); // cannot confirm old → not a MISMATCH
    expect(rec.route).toBe('/admin/editors/:id'); // pattern, no real id
  });
});

describe('fail-safe — shadow errors NEVER break the request', () => {
  test('log write rejects → next() still called, no throw', () => {
    ON();
    AuthShadowLog.create.mockReturnValueOnce(Promise.reject(new Error('db down')));
    const next = jest.fn();
    expect(() =>
      authorize.requirePermission('payments.adjust')(makeReq({ id: 'u1', role: 'subeditor' }), makeRes(), next)
    ).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('resolver throwing is swallowed → next() still called', () => {
    ON();
    const resolver = require('../utils/permissionResolver');
    const spy = jest.spyOn(resolver, 'resolve').mockImplementationOnce(() => { throw new Error('boom'); });
    const next = jest.fn();
    const res = makeRes();
    expect(() =>
      authorize.requirePermission('payments.adjust')(makeReq({ id: 'u1', role: 'subeditor' }), res, next)
    ).not.toThrow();
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('no secrets logged', () => {
  test('logged record contains no password/token/bank fields', () => {
    ON();
    authorize.requirePermission('payments.adjust')(
      makeReq({ id: 'u1', role: 'subeditor', password: 'SHOULD_NOT_APPEAR', token: 'jwt' }),
      makeRes(), jest.fn()
    );
    const rec = AuthShadowLog.create.mock.calls[0][0];
    expect(JSON.stringify(rec)).not.toMatch(/SHOULD_NOT_APPEAR|jwt|password|token|ifsc|accountNumber/i);
  });
});

describe('requireScope — non-enforcing companion', () => {
  test('flag OFF → no-op', () => {
    const next = jest.fn();
    authorize.requireScope('state')(makeReq({ role: 'subeditor', assignedStates: ['UP'] }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(AuthShadowLog.create).not.toHaveBeenCalled();
  });
  test('flag ON, matching state scope → no signal', () => {
    ON();
    const next = jest.fn();
    authorize.requireScope('state')(makeReq({ role: 'subeditor', assignedStates: ['UP'] }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(AuthShadowLog.create).not.toHaveBeenCalled();
  });
});
