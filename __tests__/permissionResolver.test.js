'use strict';

/**
 * Phase-0 Step-1 unit tests for the PURE permissionResolver.
 * These are pure-function tests: no DB, no mocks, no side effects.
 * They lock in that the resolver faithfully MIRRORS current access and never
 * grants finance/user-management to reporters or sub-editors.
 */

const { resolve, can } = require('../utils/permissionResolver');
const { PERMISSIONS: P, ALL_PERMISSIONS } = require('../constants/permissions');

describe('permissionResolver — super admin', () => {
  const su = resolve({ role: 'superadmin' });
  test('gets every permission', () => {
    expect(su.permissions.sort()).toEqual([...ALL_PERMISSIONS].sort());
  });
  test('has global scope + dashboard', () => {
    expect(su.scope.type).toBe('global');
    expect(su.dashboardAccess).toBe(true);
    expect(su.isSuperAdmin).toBe(true);
  });
});

describe('permissionResolver — admin (defensive; absent in prod)', () => {
  const a = resolve({ role: 'admin' });
  test('gets the full operational set incl. finance + user mgmt (mirrors requireAdmin today)', () => {
    expect(can({ role: 'admin' }, P.PAYMENTS_ADJUST)).toBe(true);
    expect(can({ role: 'admin' }, P.PAYMENTS_PROCESS)).toBe(true);
    expect(can({ role: 'admin' }, P.USERS_DELETE)).toBe(true);
    expect(a.scope.type).toBe('global');
  });
});

describe('permissionResolver — sub-editor', () => {
  test('plain sub-editor: scoped news view, NO finance/user/settings', () => {
    const s = resolve({ role: 'subeditor', permissions: { canAccessAdminDashboard: true } });
    expect(s.permissions).toContain(P.NEWS_VIEW);
    expect(s.dashboardAccess).toBe(true);
    expect(s.permissions).not.toContain(P.PAYMENTS_ADJUST);
    expect(s.permissions).not.toContain(P.PAYMENTS_PROCESS);
    expect(s.permissions).not.toContain(P.WALLET_FREEZE);
    expect(s.permissions).not.toContain(P.USERS_CREATE);
    expect(s.permissions).not.toContain(P.SETTINGS_MANAGE);
    expect(s.scope.type).toBe('managed');
  });

  test('permission-bag flags map correctly', () => {
    const s = resolve({
      role: 'subeditor',
      permissions: { canApproveNews: true, canEditNews: true, canSendNotifications: true, canViewAllNews: true },
    });
    expect(s.permissions).toEqual(expect.arrayContaining([
      P.NEWS_APPROVE, P.NEWS_REJECT, P.NEWS_EDIT, P.NOTIFICATIONS_SEND, P.NEWS_VIEW,
    ]));
    expect(s.scope.type).toBe('global'); // canViewAllNews widens news scope
    expect(s.permissions).not.toContain(P.PAYMENTS_APPROVE); // still no finance
  });

  test('State-In-Charge (via assignedStates): assignments+state scope, NO approve/finance', () => {
    const s = resolve({ role: 'subeditor', assignedStates: ['Uttar Pradesh'], permissions: { canAccessAdminDashboard: true } });
    expect(s.isStateIncharge).toBe(true);
    expect(s.permissions).toEqual(expect.arrayContaining([P.ASSIGNMENTS_CREATE, P.ASSIGNMENTS_VIEW, P.REPORTERS_VIEW]));
    expect(s.permissions).not.toContain(P.ASSIGNMENTS_APPROVE); // admin approves, not the in-charge
    expect(s.permissions).not.toContain(P.PAYMENTS_ADJUST);
    expect(s.scope.type).toBe('state');
    expect(s.scope.states).toContain('Uttar Pradesh');
  });

  test('State-In-Charge detected from messy displayRole ("Karnataka Incharge")', () => {
    const s = resolve({ role: 'subeditor', displayRole: 'Karnataka Incharge' });
    expect(s.isStateIncharge).toBe(true);
    expect(s.permissions).toContain(P.ASSIGNMENTS_CREATE);
  });

  test('managedDistricts / managedReporterIds set district / reporters scope', () => {
    expect(resolve({ role: 'subeditor', managedDistricts: ['Etawah'] }).scope.type).toBe('district');
    expect(resolve({ role: 'subeditor', managedReporterIds: ['x'] }).scope.type).toBe('reporters');
  });
});

describe('permissionResolver — reporter (role editor)', () => {
  test('own news + self wallet ONLY; no dashboard, no finance', () => {
    const r = resolve({ role: 'editor' });
    expect(r.permissions.sort()).toEqual([P.NEWS_CREATE, P.NEWS_VIEW, P.WALLET_SELF].sort());
    expect(r.scope.type).toBe('own');
    expect(r.dashboardAccess).toBe(false);
    expect(r.permissions).not.toContain(P.PAYMENTS_ADJUST);
  });

  test('reporterTier=district_incharge grants NO extra access (earnings only)', () => {
    const r = resolve({ role: 'editor', reporterTier: 'district_incharge', assignedDistricts: ['Pilibhit'] });
    expect(r.isDistrictIncharge).toBe(true);
    expect(r.permissions.sort()).toEqual([P.NEWS_CREATE, P.NEWS_VIEW, P.WALLET_SELF].sort());
    expect(r.permissions).not.toContain(P.PAYMENTS_APPROVE);
    expect(r.permissions).not.toContain(P.WALLET_FREEZE);
  });
});

describe('permissionResolver — messy data + safety', () => {
  test('trailing-space / hyphen displayRole variants do not crash and normalize', () => {
    expect(() => resolve({ role: 'subeditor', displayRole: 'Sub Editor ' })).not.toThrow();
    expect(() => resolve({ role: 'subeditor', displayRole: 'Sub-Editor' })).not.toThrow();
  });

  test('unknown / empty / null user → safe deny-all', () => {
    expect(resolve({}).permissions).toEqual([]);
    expect(resolve({ role: 'weird' }).permissions).toEqual([]);
    expect(resolve(null).permissions).toEqual([]);
    expect(resolve(undefined).scope.type).toBe('none');
  });
});

describe('permissionResolver — purity contract', () => {
  test('deterministic + does not mutate its input', () => {
    const input = { role: 'subeditor', assignedStates: ['UP'], permissions: { canApproveNews: true } };
    const snapshot = JSON.stringify(input);
    const a = resolve(input);
    const b = resolve(input);
    expect(a).toEqual(b);
    expect(JSON.stringify(input)).toBe(snapshot); // input untouched
  });
});
