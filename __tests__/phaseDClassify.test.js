'use strict';

/**
 * Phase-D classifier tests — prove the owner-approved decisions are encoded
 * exactly, using hard fields only (pure function, no DB).
 */

const { classify, ROLES, DEPARTMENTS } = require('../scripts/migrations/phaseD-org-migration');
const { ALL_PERMISSIONS } = require('../constants/permissions');

describe('Phase D — approved decision rules', () => {
  test('superadmin → ADMIN_IT / Super Admin', () => {
    expect(classify({ role: 'superadmin' })).toMatchObject({ dept: 'ADMIN_IT', role: 'Super Admin' });
  });

  test('Decision 3: stringer = Reporter (single role)', () => {
    expect(classify({ role: 'editor', reporterTier: 'stringer' })).toMatchObject({ dept: 'FIELD_OPS', role: 'Reporter' });
  });

  test('district_incharge with districts → District In-Charge', () => {
    expect(classify({ role: 'editor', reporterTier: 'district_incharge', assignedDistricts: ['Etawah'] }))
      .toMatchObject({ role: 'District In-Charge' });
  });

  test('district_incharge WITHOUT districts → skipped for review', () => {
    expect(classify({ role: 'editor', reporterTier: 'district_incharge' }).skip).toBe(true);
  });

  test('Decision 1: Bureau + canApproveNews → State In-Charge (e.g. Ashraf/S K Rajiv)', () => {
    const u = { role: 'subeditor', displayRole: 'Bureau', assignedStates: ['Bihar', 'Jharkhand'], permissions: { canApproveNews: true, approvalScope: 'geography' } };
    expect(classify(u)).toMatchObject({ dept: 'FIELD_OPS', role: 'State In-Charge', group: 'bureau_sic' });
  });

  test('Decision 1: Bureau WITHOUT canApproveNews (JAYA DWIVEDI case) → skipped', () => {
    const u = { role: 'subeditor', displayRole: 'Bureau', assignedStates: ['Chhattisgarh'], permissions: { canApproveNews: false } };
    const c = classify(u);
    expect(c.skip).toBe(true);
    expect(c.reason).toMatch(/Bureau WITHOUT/);
  });

  test('titled State In-Charge (Prashanth pattern) → State In-Charge', () => {
    const u = { role: 'subeditor', displayRole: 'Karnataka Incharge', assignedStates: ['Karnataka'], permissions: {} };
    expect(classify(u)).toMatchObject({ role: 'State In-Charge', group: 'titled_sic' });
  });

  test('Decision 4: yellow + approve + geography (Raju Nirala / GAJANAN) → State In-Charge', () => {
    const u = { role: 'subeditor', displayRole: 'Sub Editor', assignedStates: ['Chhattisgarh'], permissions: { canApproveNews: true, approvalScope: 'geography' } };
    expect(classify(u)).toMatchObject({ role: 'State In-Charge', group: 'yellow_sic' });
  });

  test('Decision 4: all other yellows → Editor (Desk) — Dheeraj (aScope=all)', () => {
    const u = { role: 'subeditor', displayRole: 'Sub Editor', assignedStates: ['AP', 'Bihar'], permissions: { canApproveNews: false, approvalScope: 'all' } };
    expect(classify(u)).toMatchObject({ dept: 'EDIT', role: 'Editor (Desk)' });
  });

  test('Decision 4: reporter-scoped yellows also → Desk (K.L.V. pattern: approve+reporters)', () => {
    const u = { role: 'subeditor', displayRole: 'Sub Editor', assignedStates: ['AP'], permissions: { canApproveNews: true, approvalScope: 'reporters' } };
    expect(classify(u)).toMatchObject({ role: 'Editor (Desk)' });
  });

  test('Decision 4: geography WITHOUT approve (Ashok Kumar / Kalyani) → Desk per owner override', () => {
    const u = { role: 'subeditor', displayRole: 'Sub Editor', assignedStates: ['Haryana'], permissions: { canApproveNews: false, approvalScope: 'geography' } };
    expect(classify(u)).toMatchObject({ role: 'Editor (Desk)' });
  });

  test('Kuldeep pattern (incharge title, zero states) → skipped for review', () => {
    const u = { role: 'subeditor', displayRole: 'MH Incharge', permissions: { approvalScope: 'all' } };
    expect(classify(u).skip).toBe(true);
  });

  test('dormant sub-editor (no states, no signals) → skipped', () => {
    expect(classify({ role: 'subeditor', displayRole: 'Sub Editor', permissions: {} }).skip).toBe(true);
  });

  test('exactly 5 roles / 3 departments defined; all role permissions from catalog', () => {
    expect(ROLES.length).toBe(5);
    expect(DEPARTMENTS.length).toBe(3);
    expect(ROLES.map(r => r.name)).toEqual(['Super Admin', 'Reporter', 'District In-Charge', 'State In-Charge', 'Editor (Desk)']);
    ROLES.forEach(r => r.permissions.forEach(p => expect(ALL_PERMISSIONS).toContain(p)));
  });
});
