'use strict';

/**
 * Phase-A — Organization schema foundation tests (schema only, no DB).
 *
 * Proves: (1) legacy Admin documents remain valid and behave identically,
 * (2) the four new Admin fields are optional/nullable with safe defaults,
 * (3) Department/Team/Role schemas validate correctly (Team requires a
 * Department; Role permissions must come from the existing catalog),
 * (4) NO production code path reads the new fields yet (filesystem scan).
 *
 * All checks use validateSync()/new Model() — no MongoDB connection required.
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Admin = require('../models/Admin');
const Department = require('../models/Department');
const Team = require('../models/Team');
const Role = require('../models/Role');
const { resolve } = require('../utils/permissionResolver');
const { PERMISSIONS } = require('../constants/permissions');

const legacyAdminFields = {
  username: 'legacy_reporter',
  email: 'legacy@example.com',
  password: 'secret123',
  role: 'editor',
  displayRole: 'Stringer',
  reporterTier: 'stringer',
  assignedStates: ['Uttar Pradesh'],
  permissions: { canAccessAdminDashboard: false },
};

describe('Phase A — Admin backward compatibility', () => {
  test('legacy Admin (no new fields) validates cleanly', () => {
    const doc = new Admin(legacyAdminFields);
    expect(doc.validateSync()).toBeUndefined();
  });

  test('new fields default to null / empty array', () => {
    const doc = new Admin(legacyAdminFields);
    expect(doc.departmentId).toBeNull();
    expect(doc.teamId).toBeNull();
    expect(doc.reportingManagerId).toBeNull();
    expect(Array.isArray(doc.roleIds)).toBe(true);
    expect(doc.roleIds.length).toBe(0);
  });

  test('new fields are optional — setting them also validates', () => {
    const doc = new Admin({
      ...legacyAdminFields,
      username: 'u2', email: 'u2@example.com',
      departmentId: new mongoose.Types.ObjectId(),
      teamId: new mongoose.Types.ObjectId(),
      roleIds: [new mongoose.Types.ObjectId()],
      reportingManagerId: new mongoose.Types.ObjectId(),
    });
    expect(doc.validateSync()).toBeUndefined();
  });

  test('invalid ObjectId in new fields is rejected by schema casting', () => {
    const doc = new Admin({ ...legacyAdminFields, username: 'u3', email: 'u3@example.com', departmentId: 'not-an-id' });
    expect(doc.validateSync()).toBeDefined(); // cast error surfaces in validation
  });

  test('legacy role/permissions values are untouched by the new fields', () => {
    const doc = new Admin(legacyAdminFields);
    expect(doc.role).toBe('editor');
    expect(doc.reporterTier).toBe('stringer');
    expect(doc.displayRole).toBe('Stringer');
    expect(doc.permissions.canAccessAdminDashboard).toBe(false);
  });

  test('permission resolver output is IDENTICAL with and without the new fields', () => {
    const legacy = { role: 'editor', reporterTier: 'stringer', assignedStates: ['UP'] };
    const withOrg = {
      ...legacy,
      departmentId: new mongoose.Types.ObjectId(),
      teamId: new mongoose.Types.ObjectId(),
      roleIds: [new mongoose.Types.ObjectId()],
      reportingManagerId: new mongoose.Types.ObjectId(),
    };
    const a = resolve(legacy);
    const b = resolve(withOrg);
    expect(b.permissions.sort()).toEqual(a.permissions.sort());
    expect(b.scope).toEqual(a.scope);
    expect(b.dashboardAccess).toBe(a.dashboardAccess);
  });
});

describe('Phase A — Department schema', () => {
  test('valid department validates; status defaults to active', () => {
    const d = new Department({ name: 'Editorial', code: 'edit' });
    expect(d.validateSync()).toBeUndefined();
    expect(d.status).toBe('active');
    expect(d.code).toBe('EDIT'); // uppercased
    expect(d.headId).toBeNull();
  });

  test('name and code are required', () => {
    expect(new Department({}).validateSync()).toBeDefined();
    expect(new Department({ name: 'X' }).validateSync()).toBeDefined();
  });

  test('status enum rejects invalid values (disable-over-delete lifecycle)', () => {
    const d = new Department({ name: 'A', code: 'A1', status: 'deleted' });
    expect(d.validateSync()).toBeDefined();
  });
});

describe('Phase A — Team schema', () => {
  test('team REQUIRES a department', () => {
    const t = new Team({ name: 'Payments Team' });
    const err = t.validateSync();
    expect(err).toBeDefined();
    expect(err.errors.departmentId).toBeDefined();
  });

  test('valid team (with department) validates', () => {
    const t = new Team({ name: 'Payments Team', departmentId: new mongoose.Types.ObjectId() });
    expect(t.validateSync()).toBeUndefined();
    expect(t.leadId).toBeNull();
    expect(t.status).toBe('active');
  });
});

describe('Phase A — Role schema', () => {
  test('valid role with catalog permission codes validates', () => {
    const r = new Role({
      name: 'Accounts Manager',
      permissions: [PERMISSIONS.PAYMENTS_VIEW, PERMISSIONS.PAYMENTS_REVIEW, PERMISSIONS.PAYMENTS_APPROVE],
      defaultScopeType: 'global',
    });
    expect(r.validateSync()).toBeUndefined();
    expect(r.isSystem).toBe(false);
  });

  test('rejects a permission code NOT in the existing catalog', () => {
    const r = new Role({ name: 'Bad Role', permissions: ['payments.hack_everything'] });
    const err = r.validateSync();
    expect(err).toBeDefined();
    expect(err.errors.permissions).toBeDefined();
  });

  test('rejects an invalid defaultScopeType', () => {
    const r = new Role({ name: 'Odd Role', defaultScopeType: 'universe' });
    expect(r.validateSync()).toBeDefined();
  });

  test('does not touch/replace Admin.role enum', () => {
    // Admin.role stays the coarse auth tier with its original enum.
    const doc = new Admin({ ...legacyAdminFields, username: 'u9', email: 'u9@example.com', role: 'not-a-tier' });
    expect(doc.validateSync()).toBeDefined(); // original enum still enforced
  });
});

describe('Phase A — no production code reads the new fields yet', () => {
  test('controllers/services/routes/middleware/utils contain zero references', () => {
    const dirs = ['controllers', 'services', 'routes', 'middleware', 'utils', 'views'];
    const needle = /departmentId|teamId|roleIds|reportingManagerId/;
    const offenders = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.(js|ejs)$/.test(f.name)) {
          const src = fs.readFileSync(p, 'utf8');
          // editorCoverageHelper has a LOCAL variable `teamIds` (pre-existing, unrelated).
          const cleaned = src.replace(/\bteamIds\b/g, '');
          if (needle.test(cleaned)) offenders.push(p);
        }
      }
    };
    dirs.forEach((d) => { if (fs.existsSync(path.join(__dirname, '..', d))) walk(path.join(__dirname, '..', d)); });
    expect(offenders).toEqual([]); // only models/ + this test may reference them
  });
});
