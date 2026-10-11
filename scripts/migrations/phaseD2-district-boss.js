'use strict';

/**
 * PHASE D2 — District-Division based boss assignment (owner-approved).
 *
 * Fills reportingManagerId for boss-less reporters using the DISTRICT DIVISION
 * the owner already created in /admin/district-division (stored in each
 * in-charge's permissions.managedDistricts). A reporter gets a boss ONLY when
 * their district matches EXACTLY ONE in-charge's division list — never guessed.
 *
 * Touches ONLY Admin.reportingManagerId, and ONLY where it is currently null.
 * Legacy fields (role, permissions, tier, assigned-fields, wallet) are never written.
 *
 * MODES:
 *   node scripts/migrations/phaseD2-district-boss.js             → DRY RUN (zero writes)
 *   node scripts/migrations/phaseD2-district-boss.js --apply     → set managers
 *   node scripts/migrations/phaseD2-district-boss.js --rollback  → re-null ONLY the district-matched ones
 */

require('dotenv').config();
const mongoose = require('mongoose');

const normD = (d) => String(d == null ? '' : d).trim().toLowerCase();

async function main() {
  const APPLY = process.argv.includes('--apply');
  const ROLLBACK = process.argv.includes('--rollback');
  console.log(`\n══════ PHASE D2 DISTRICT-BOSS — MODE: ${ROLLBACK ? 'ROLLBACK' : APPLY ? 'APPLY' : 'DRY RUN'} ══════`);

  await mongoose.connect(process.env.MONGODB_URI);
  const Admin = require('../../models/Admin');

  // In-charges who have a district division (the owner-made split).
  const sics = (await Admin.find(
    { role: 'subeditor', 'permissions.managedDistricts.0': { $exists: true } },
    'name permissions.managedDistricts'
  ).lean()).map((s) => ({ id: s._id, name: s.name, dists: (s.permissions.managedDistricts || []).map(normD) }));
  console.log('Division-holding in-charges:', sics.map((s) => `${s.name}(${s.dists.length})`).join(', '));

  // Duplicate-district safety: a district owned by 2+ in-charges is ambiguous → skipped.
  const owners = {};
  sics.forEach((s) => s.dists.forEach((d) => { (owners[d] = owners[d] || []).push(s); }));
  const dup = Object.keys(owners).filter((d) => owners[d].length > 1);
  if (dup.length) console.log(`⚠️ districts owned by MULTIPLE in-charges (skipped): ${dup.join(', ')}`);

  const targetFilter = ROLLBACK
    ? { role: 'editor', reportingManagerId: { $ne: null } }
    : { role: 'editor', reportingManagerId: null };
  const reporters = await Admin.find(targetFilter, 'name assignedDistricts constituency reportingManagerId').lean();

  const plan = []; const byBoss = {};
  for (const r of reporters) {
    let rd = (r.assignedDistricts || []).map(normD).filter(Boolean);
    if (!rd.length && r.constituency) rd = [normD(r.constituency)];
    if (!rd.length) continue;
    const matched = sics.filter((s) => rd.some((d) => s.dists.includes(d) && owners[d].length === 1));
    if (matched.length !== 1) continue; // only EXACTLY ONE — never guess
    if (String(matched[0].id) === String(r._id)) continue;
    if (ROLLBACK && String(r.reportingManagerId) !== String(matched[0].id)) continue; // only undo OUR sets
    plan.push({ rid: r._id, name: r.name, boss: matched[0] });
    byBoss[matched[0].name] = (byBoss[matched[0].name] || 0) + 1;
  }

  console.log(`\n${ROLLBACK ? 'Would clear' : 'Would set'} bosses for ${plan.length} reporters:`);
  Object.entries(byBoss).sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${n}: ${c} reporters`));

  if (!APPLY && !ROLLBACK) {
    console.log('\nDRY RUN — zero writes. Re-run with --apply to set.');
    await mongoose.disconnect(); return;
  }

  let done = 0;
  for (const p of plan) {
    await Admin.updateOne({ _id: p.rid }, ROLLBACK
      ? { $set: { reportingManagerId: null } }
      : { $set: { reportingManagerId: p.boss.id } });
    done++;
  }
  try {
    await require('../../models/AuditLog').create({
      actorName: 'script:phaseD2-district-boss', actorRole: 'system',
      action: ROLLBACK ? 'org_district_boss_rollback' : 'org_district_boss_set',
      entityType: 'Admin', entityId: 'bulk',
      description: `${ROLLBACK ? 'Cleared' : 'Set'} reportingManagerId for ${done} reporters via district division: ${JSON.stringify(byBoss)}`
    });
  } catch (e) { console.error('audit failed (non-blocking):', e.message); }
  console.log(`\n${ROLLBACK ? 'ROLLBACK' : 'APPLY'} complete: ${done} reporters updated.`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
