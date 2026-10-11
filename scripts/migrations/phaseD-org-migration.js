'use strict';

/**
 * PHASE D — Organization migration (approved in Phase C review).
 *
 * Creates 3 departments + 5 roles, then writes ONLY the Phase-A org-metadata
 * fields (departmentId, roleIds, reportingManagerId) onto Admin documents.
 *
 * APPROVED DECISIONS (owner-confirmed):
 *  1. Bureau users (with canApproveNews) → role State In-Charge (displayRole "Bureau" untouched).
 *     Bureau WITHOUT canApproveNews (JAYA DWIVEDI) → skipped for manual review.
 *  2. Reporters' + District In-Charges' manager = their state's State In-Charge
 *     (only when EXACTLY ONE ACTIVE State In-Charge covers that state; else left null for review).
 *  3. Reporter = Stringer (single "Reporter" role; reporterTier stays untouched — pay only).
 *  4. YELLOW sub-editors: canApproveNews + approvalScope 'geography' → State In-Charge
 *     (= Raju Nirala, GAJANAN BIDKAR); all other YELLOWs → Editor (Desk).
 *
 * NEVER TOUCHES: role, permissions, displayRole, reporterTier, assignedStates,
 * assignedDistricts, managed*, allowedScopes, wallet, salary — legacy stays authoritative.
 * Org metadata grants ZERO access (no enforcement anywhere).
 *
 * MODES (run from app root, e.g. /var/www/yellowsingam):
 *   node scripts/migrations/phaseD-org-migration.js              → DRY RUN (default; zero writes)
 *   node scripts/migrations/phaseD-org-migration.js --apply      → perform the migration
 *   node scripts/migrations/phaseD-org-migration.js --rollback   → remove org metadata + created depts/roles
 *
 * Idempotent: departments/roles are upserted by code/name; user updates $set the
 * same values on re-run. Rollback only $unsets the four Phase-A fields.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { PERMISSIONS: P } = require('../../constants/permissions');

const DEPARTMENTS = [
  { code: 'FIELD_OPS', name: 'Field Operations', description: 'Reporters, District & State In-Charges, assignments', sortOrder: 1 },
  { code: 'EDIT', name: 'Editorial', description: 'HQ news desk — approval and editing', sortOrder: 2 },
  { code: 'ADMIN_IT', name: 'Administration & IT', description: 'Super Admin, system, security & audit', sortOrder: 3 },
];

const ROLES = [
  { name: 'Super Admin', isSystem: true, deptCode: 'ADMIN_IT', defaultScopeType: 'global', description: 'Full organizational control', permissions: Object.values(P) },
  { name: 'Reporter', isSystem: true, deptCode: 'FIELD_OPS', defaultScopeType: 'own', description: 'Submits own news; self wallet (stringers included)', permissions: [P.NEWS_CREATE, P.NEWS_VIEW, P.WALLET_SELF] },
  { name: 'District In-Charge', isSystem: false, deptCode: 'FIELD_OPS', defaultScopeType: 'district', description: 'Reporter with district responsibility (₹10 tier stays in reporterTier)', permissions: [P.NEWS_CREATE, P.NEWS_VIEW, P.WALLET_SELF, P.REPORTERS_VIEW] },
  { name: 'State In-Charge', isSystem: false, deptCode: 'FIELD_OPS', defaultScopeType: 'state', description: 'Approves/edits state news; proposes reporter assignments', permissions: [P.NEWS_VIEW, P.NEWS_APPROVE, P.NEWS_REJECT, P.NEWS_EDIT, P.ASSIGNMENTS_VIEW, P.ASSIGNMENTS_CREATE, P.REPORTERS_VIEW] },
  { name: 'Editor (Desk)', isSystem: false, deptCode: 'EDIT', defaultScopeType: 'managed', description: 'HQ desk — org-wide editing/approval', permissions: [P.NEWS_VIEW, P.NEWS_APPROVE, P.NEWS_REJECT, P.NEWS_EDIT] },
];

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/[\s._-]+/g, ' ').trim(); }
function isInchargeTitle(dr) { return /\bin ?charge\b/.test(norm(dr)); }
function statesOf(u) {
  return (u.assignedStates && u.assignedStates.length) ? u.assignedStates : (u.assignedState ? [u.assignedState] : []);
}

/**
 * Pure classifier — encodes the owner-approved decisions on HARD fields only.
 * Returns { dept, role, group } or { skip: true, reason }.
 */
function classify(u) {
  const p = u.permissions || {};
  const states = statesOf(u);
  const districts = u.assignedDistricts || [];
  const dr = norm(u.displayRole);

  if (u.role === 'superadmin') return { dept: 'ADMIN_IT', role: 'Super Admin', group: 'superadmin' };

  if (u.role === 'editor') {
    if (u.reporterTier === 'district_incharge' && districts.length > 0) return { dept: 'FIELD_OPS', role: 'District In-Charge', group: 'district_incharge' };
    if (u.reporterTier === 'district_incharge') return { skip: true, reason: 'tier=district_incharge but no assignedDistricts' };
    if (u.reporterTier === 'stringer') return { dept: 'FIELD_OPS', role: 'Reporter', group: 'reporter' };
    return { skip: true, reason: 'editor with null reporterTier' };
  }

  if (u.role === 'subeditor') {
    if (/\bbureau\b/.test(dr)) {
      // Decision 1: Bureau + canApproveNews → State In-Charge; without → review (JAYA DWIVEDI).
      if (p.canApproveNews === true) return { dept: 'FIELD_OPS', role: 'State In-Charge', group: 'bureau_sic' };
      return { skip: true, reason: 'Bureau WITHOUT canApproveNews — manual review' };
    }
    if (states.length > 0 && isInchargeTitle(dr)) return { dept: 'FIELD_OPS', role: 'State In-Charge', group: 'titled_sic' };
    if (states.length > 0) {
      // Decision 4: YELLOW — approve + geography scope → State In-Charge; everyone else → Desk.
      if (p.canApproveNews === true && p.approvalScope === 'geography') return { dept: 'FIELD_OPS', role: 'State In-Charge', group: 'yellow_sic' };
      return { dept: 'EDIT', role: 'Editor (Desk)', group: 'desk' };
    }
    return { skip: true, reason: 'subeditor without states — manual review (dormant/misconfigured)' };
  }

  return { skip: true, reason: 'unexpected role: ' + u.role };
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const ROLLBACK = process.argv.includes('--rollback');
  const mode = ROLLBACK ? 'ROLLBACK' : APPLY ? 'APPLY' : 'DRY RUN';
  console.log(`\n══════ PHASE D ORG MIGRATION — MODE: ${mode} ══════`);

  await mongoose.connect(process.env.MONGODB_URI);
  const Admin = require('../../models/Admin');
  const Department = require('../../models/Department');
  const Team = require('../../models/Team'); // registered for completeness; no teams created
  const Role = require('../../models/Role');

  if (ROLLBACK) {
    const r1 = await Admin.updateMany({}, { $unset: { departmentId: '', teamId: '', roleIds: '', reportingManagerId: '' } });
    const r2 = await Role.deleteMany({ name: { $in: ROLES.map(r => r.name) } });
    const r3 = await Department.deleteMany({ code: { $in: DEPARTMENTS.map(d => d.code) } });
    console.log(`Rolled back: ${r1.modifiedCount} admins cleared, ${r2.deletedCount} roles removed, ${r3.deletedCount} departments removed.`);
    console.log('Legacy fields were never touched. Done.');
    await mongoose.disconnect(); return;
  }

  // ── 1. Departments + Roles (upsert; dry-run only prints) ──────────────────
  const deptIds = {}; const roleIds = {};
  for (const d of DEPARTMENTS) {
    if (APPLY) {
      const doc = await Department.findOneAndUpdate({ code: d.code }, { $setOnInsert: d }, { upsert: true, new: true });
      deptIds[d.code] = doc._id;
    }
    console.log(`DEPT ${APPLY ? 'ensured' : 'would create'}: ${d.name} (${d.code})`);
  }
  for (const r of ROLES) {
    if (APPLY) {
      const doc = await Role.findOneAndUpdate(
        { name: r.name },
        { $setOnInsert: { name: r.name, description: r.description, departmentId: deptIds[r.deptCode] || null, permissions: r.permissions, defaultScopeType: r.defaultScopeType, isSystem: r.isSystem } },
        { upsert: true, new: true }
      );
      roleIds[r.name] = doc._id;
    }
    console.log(`ROLE ${APPLY ? 'ensured' : 'would create'}: ${r.name} → [${r.permissions.length} permissions], scope=${r.defaultScopeType}`);
  }

  // ── 2. Classify every admin ───────────────────────────────────────────────
  const admins = await Admin.find({}, 'name username role displayRole reporterTier assignedState assignedStates assignedDistricts permissions isActive').lean();
  const mapped = []; const skipped = [];
  for (const u of admins) {
    const c = classify(u);
    if (c.skip) skipped.push({ u, reason: c.reason });
    else mapped.push({ u, c });
  }

  const groupCounts = {};
  mapped.forEach(m => { groupCounts[m.c.role] = (groupCounts[m.c.role] || 0) + 1; });
  console.log(`\nTotal admins: ${admins.length} | to map: ${mapped.length} | skipped for review: ${skipped.length}`);
  console.log('By role:', JSON.stringify(groupCounts));
  console.log('\n── Special-case verification (State In-Charges from Bureau/Yellow) ──');
  mapped.filter(m => m.c.group === 'bureau_sic' || m.c.group === 'yellow_sic' || m.c.group === 'titled_sic')
    .forEach(m => console.log(`  SIC: ${m.u.name || m.u.username} [${m.c.group}] states=${statesOf(m.u).join('/')}`));
  console.log('── Desk Editors ──');
  mapped.filter(m => m.c.group === 'desk').forEach(m => console.log(`  DESK: ${m.u.name || m.u.username}`));
  console.log('── Skipped (manual review) ──');
  skipped.forEach(s => console.log(`  SKIP: ${s.u.name || s.u.username} — ${s.reason}`));

  // ── 3. Manager map (Decision 2): state → exactly ONE ACTIVE State In-Charge ─
  const sics = mapped.filter(m => m.c.role === 'State In-Charge' && m.u.isActive !== false);
  const superAdmin = mapped.find(m => m.c.role === 'Super Admin');
  const stateMap = {};
  sics.forEach(m => statesOf(m.u).forEach(st => { (stateMap[st] = stateMap[st] || []).push(m.u); }));
  console.log('\n── State → State In-Charge coverage ──');
  Object.keys(stateMap).sort().forEach(st => {
    const list = stateMap[st];
    console.log(`  ${st}: ${list.map(x => x.name || x.username).join(', ')}${list.length > 1 ? '  ⚠️ MULTIPLE — reporters here left for review' : ''}`);
  });

  let mgrSet = 0, mgrNull = 0;
  const updates = [];
  for (const m of mapped) {
    const update = { departmentId: APPLY ? deptIds[m.c.dept] : m.c.dept, roleIds: APPLY ? [roleIds[m.c.role]] : [m.c.role] };
    if (m.c.role === 'Reporter' || m.c.role === 'District In-Charge') {
      const st = statesOf(m.u);
      const covers = st.length === 1 ? (stateMap[st[0]] || []) : [];
      if (covers.length === 1 && String(covers[0]._id) !== String(m.u._id)) { update.reportingManagerId = covers[0]._id; mgrSet++; }
      else mgrNull++;
    } else if ((m.c.role === 'State In-Charge' || m.c.role === 'Editor (Desk)') && superAdmin) {
      update.reportingManagerId = superAdmin.u._id; mgrSet++;
    }
    updates.push({ _id: m.u._id, update });
  }
  console.log(`\nManagers: ${mgrSet} would be set | ${mgrNull} left null (no/multiple SIC for their state → review)`);

  // ── 4. Write (APPLY only) ─────────────────────────────────────────────────
  if (!APPLY) {
    console.log('\nDRY RUN complete — ZERO writes performed. Re-run with --apply to migrate.');
    await mongoose.disconnect(); return;
  }
  let written = 0;
  for (const w of updates) {
    await Admin.updateOne({ _id: w._id }, { $set: w.update }); // ONLY org-metadata fields
    written++;
  }
  try {
    await require('../../models/AuditLog').create({
      actorName: 'script:phaseD-org-migration', actorRole: 'system',
      action: 'org_migration_phase_d', entityType: 'Admin', entityId: 'bulk',
      description: `Org metadata migration: ${written} admins mapped (${JSON.stringify(groupCounts)}), ${skipped.length} skipped for review, managers set=${mgrSet}`,
      before: null, after: { mapped: written, skipped: skipped.length, managersSet: mgrSet }
    });
  } catch (e) { console.error('audit write failed (non-blocking):', e.message); }
  console.log(`\nAPPLY complete: ${written} admins updated (org metadata only). Legacy fields untouched.`);
  await mongoose.disconnect();
}

module.exports = { classify, DEPARTMENTS, ROLES };
if (require.main === module) main().catch(e => { console.error('FATAL:', e); process.exit(1); });
