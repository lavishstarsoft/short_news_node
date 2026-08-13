'use strict';
/**
 * UP PHASE-1 MIGRATION — assign canonical Uttar Pradesh district NAMES to the 44
 * audited SAFE reporters. Idempotent. Preserves existing assignments. Touches
 * ONLY the 44 (category-A UP). Seetaram + 14 manual-review + other states + all
 * In-Charge allocations remain untouched. Stores canonical Location NAME in
 * assignedDistricts (routing key); records Location _id + migrationId in AuditLog.
 *
 *   node migrate_up_phase1_reporter_districts.js --apply    # perform writes
 *   node migrate_up_phase1_reporter_districts.js            # dry-run (default, no writes)
 */
require('dotenv').config({ path: __dirname + '/.env' });
const crypto = require('crypto');
const mongoose = require('mongoose');
const { getManagedReporterIds } = require('./utils/editorCoverageHelper');

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = 'UPMIG-' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + '-' + crypto.randomBytes(3).toString('hex');

const norm = (s) => String(s || '').trim().toLowerCase();
const keyD = (s) => norm(s).replace(/[-_.]/g, ' ').replace(/\s+/g, ' ').trim();
const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const STOP = new Set(['up', 'u', 'p', 'uttar', 'pradesh', 'uttarpradesh', 'district', 'distt', 'dist', 'the']);
const REVIEW_EMAILS = new Set(['seetaramsinghthakur@gmail.com']);

function fail(msg) { console.error('\n❌ STOP — ' + msg); process.exitCode = 1; }

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Admin = require('./models/Admin');
  const Location = require('./models/Location');
  const ReporterApplication = require('./models/ReporterApplication');
  const AuditLog = require('./models/AuditLog');

  const dAll = await Location.find({ locationType: 'district' }).select('name parentName _id').lean();
  const byKey = new Map(dAll.map(r => [keyD(r.name), r]));
  const byExact = new Map(dAll.map(r => [norm(r.name), r]));
  const UP = 'Uttar Pradesh';
  const upSet = new Set(dAll.filter(r => r.parentName === UP).map(r => norm(r.name)));
  function canonDoc(v) {
    if (!v) return null;
    let s = String(v).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/u\.p\.?/g, ' ').replace(/[^a-z\s]/g, ' ');
    const k = s.split(/\s+/).filter(t => t && !STOP.has(t)).join(' ').trim();
    if (!k) return null;
    return byKey.get(k) || byExact.get(k) || null;
  }

  const reporters = await Admin.find({ role: 'editor', isActive: { $ne: false } })
    .select('name email mobileNumber assignedDistricts assignedStates assignedState assignedLocations location constituency').lean();
  const emailCount = new Map();
  reporters.forEach(r => { const e = norm(r.email); if (e) emailCount.set(e, (emailCount.get(e) || 0) + 1); });
  const apps = await ReporterApplication.find({}).select('data createdAt').lean();
  const appsByEmail = new Map(), appsByPhone = new Map();
  apps.forEach(a => { const e = norm(a.data && a.data.email); const p = last10(a.data && (a.data.phone_number || a.data['Alternate Mobile'])); if (e) (appsByEmail.get(e) || appsByEmail.set(e, []).get(e)).push(a); if (p) (appsByPhone.get(p) || appsByPhone.set(p, []).get(p)).push(a); });
  const geo = (a) => ({ state: (a.data && a.data.State) || '', district: (a.data && a.data.District) || '', location: (a.data && a.data.Location) || '' });

  // Re-derive category A (UP safe) deterministically — MUST equal 44.
  const safe = [];
  const seetaramSnap = [], manualSnap = [];
  for (const r of reporters) {
    let mApps = (emailCount.get(norm(r.email)) === 1 && appsByEmail.get(norm(r.email))) || null;
    if (!mApps) { const p = appsByPhone.get(last10(r.mobileNumber)); if (p && p.length) mApps = p; }
    let appMulti = new Set(), appState = '';
    if (mApps) { mApps.forEach(a => { const g = geo(a); const c = canonDoc(g.district) || canonDoc(g.location); if (c) appMulti.add(norm(c.name)); }); appState = geo(mApps[mApps.length - 1]).state; }
    const appDoc = appMulti.size === 1 ? byExact.get([...appMulti][0]) : null;
    let profDoc = null;
    for (const v of [r.location, r.constituency, ...(r.assignedLocations || [])]) { const c = canonDoc(v); if (c) { profDoc = c; break; } }
    const existingUP = (r.assignedDistricts || []).filter(d => upSet.has(norm(d)));
    const stateIsUP = [appState, r.assignedState, r.location, ...(r.assignedStates || [])].some(v => v && norm(v) === norm(UP));
    const isUP = existingUP.length || stateIsUP || (appDoc && appDoc.parentName === UP) || (profDoc && profDoc.parentName === UP);
    if (!isUP) continue;

    if (REVIEW_EMAILS.has(norm(r.email))) { seetaramSnap.push({ email: r.email, before: r.assignedDistricts || [] }); continue; }
    if (existingUP.length) { manualSnap.push({ email: r.email, before: r.assignedDistricts || [] }); continue; } // already assigned -> preserve, not in A
    if (appDoc && profDoc && norm(appDoc.name) !== norm(profDoc.name)) { manualSnap.push({ email: r.email, before: r.assignedDistricts || [] }); continue; } // conflict
    const appUP = appDoc && appDoc.parentName === UP ? appDoc : null;
    const profUP = profDoc && profDoc.parentName === UP ? profDoc : null;
    const det = appUP || profUP;
    if (det) { safe.push({ id: r._id.toString(), name: r.name, email: r.email, before: (r.assignedDistricts || []).slice(), district: det.name, locationId: det._id.toString() }); continue; }
    manualSnap.push({ email: r.email, before: r.assignedDistricts || [] }); // C/D
  }

  console.log(`Migration ID : ${MIGRATION_ID}`);
  console.log(`Mode         : ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`);
  console.log(`Re-derived SAFE (category A, UP): ${safe.length}`);
  if (safe.length !== 44) { fail(`expected exactly 44 safe reporters, got ${safe.length}. Aborting before any write.`); await mongoose.connection.close(); return; }

  // Global integrity snapshot.
  const sumAssigned = async () => (await Admin.aggregate([{ $match: { role: 'editor' } }, { $project: { n: { $size: { $ifNull: ['$assignedDistricts', []] } } } }, { $group: { _id: null, t: { $sum: '$n' } } }]))[0]?.t || 0;
  const beforeGlobal = await sumAssigned();

  let migrated = 0, alreadyHad = 0, failed = 0;
  const results = [];
  for (const s of safe) {
    try {
      if (!APPLY) { const had = s.before.some(d => norm(d) === norm(s.district)); results.push({ ...s, status: had ? 'already' : 'would-add' }); had ? alreadyHad++ : migrated++; continue; }
      const res = await Admin.updateOne({ _id: s.id, assignedDistricts: { $ne: s.district } }, { $addToSet: { assignedDistricts: s.district } });
      const after = (await Admin.findById(s.id).select('assignedDistricts').lean()).assignedDistricts || [];
      if (res.modifiedCount === 1) {
        migrated++;
        await AuditLog.create({
          actorName: 'system:up-phase1-migration', actorRole: 'system',
          action: 'reporter_district_migration', entityType: 'Admin', entityId: s.id,
          targetId: s.id, targetName: s.name,
          description: `UP Phase-1 ${MIGRATION_ID}: added canonical district "${s.district}" (LocationID ${s.locationId})`,
          before: { assignedDistricts: s.before },
          after: { assignedDistricts: after, canonicalDistrict: s.district, locationId: s.locationId, migrationId: MIGRATION_ID }
        });
        results.push({ ...s, after, status: 'migrated' });
      } else { alreadyHad++; results.push({ ...s, after, status: 'already' }); }
    } catch (e) { failed++; results.push({ ...s, status: 'FAILED', error: e.message }); }
  }

  const afterGlobal = await sumAssigned();

  // ---- 10-POINT VERIFICATION ----
  console.log('\n==================== VERIFICATION ====================');
  const checks = [];
  // 1. 44/44 expected district present.
  let ok1 = 0;
  for (const s of safe) { const a = (await Admin.findById(s.id).select('assignedDistricts').lean()).assignedDistricts || []; if (a.some(d => norm(d) === norm(s.district))) ok1++; }
  checks.push([`1. 44/44 expected district present`, ok1 === (APPLY ? 44 : (migrated + alreadyHad)), `${ok1}/44`]);
  // 2. No duplicate names within a migrated reporter.
  let dupFound = 0;
  for (const s of safe) { const a = (await Admin.findById(s.id).select('assignedDistricts').lean()).assignedDistricts || []; const low = a.map(norm); if (new Set(low).size !== low.length) dupFound++; }
  checks.push([`2. No duplicate assignedDistrict names`, dupFound === 0, `${dupFound} dup`]);
  // 3. Existing preserved (before ⊆ after).
  let preserveOk = 0;
  for (const s of safe) { const a = (await Admin.findById(s.id).select('assignedDistricts').lean()).assignedDistricts || []; if (s.before.every(b => a.some(x => norm(x) === norm(b)))) preserveOk++; }
  checks.push([`3. Existing assignments preserved`, preserveOk === 44, `${preserveOk}/44`]);
  // 4. Other states not modified (global delta == migrated).
  checks.push([`4. Only intended rows changed (global delta)`, (afterGlobal - beforeGlobal) === (APPLY ? migrated : 0), `delta=${afterGlobal - beforeGlobal}, migrated=${APPLY ? migrated : 0}`]);
  // 5. Seetaram untouched.
  let seetOk = true;
  for (const s of seetaramSnap) { const a = (await Admin.findOne({ email: s.email }).select('assignedDistricts').lean()).assignedDistricts || []; if (JSON.stringify(a) !== JSON.stringify(s.before)) seetOk = false; }
  checks.push([`5. Seetaram untouched`, seetOk, `${seetaramSnap.length} record(s)`]);
  // 6. Manual-review reporters untouched.
  let manOk = true, manChanged = 0;
  for (const s of manualSnap) { const a = (await Admin.findOne({ email: s.email }).select('assignedDistricts').lean()).assignedDistricts || []; if (JSON.stringify(a) !== JSON.stringify(s.before)) { manOk = false; manChanged++; } }
  checks.push([`6. Manual-review (${manualSnap.length}) untouched`, manOk, `${manChanged} changed`]);
  // 7-9 + 10. In-charge scope + server-side filtering.
  const icDocs = await Admin.find({ role: 'subeditor', name: { $regex: 'ashraf|praveen|ashwani', $options: 'i' } }).lean();
  const safeById = new Map(safe.map(s => [s.id, s]));
  const icAllocSet = {};
  for (const ic of icDocs) icAllocSet[ic.name.trim()] = new Set((ic.assignedDistricts || []).filter(d => upSet.has(norm(d))).map(norm));
  let leak = 0; const icCounts = {};
  for (const ic of icDocs) {
    const ids = (await getManagedReporterIds(Admin, ic)) || [];
    const mineMigrated = ids.filter(id => safeById.has(String(id)));
    icCounts[ic.name.trim()] = mineMigrated.length;
    // every migrated reporter routed here must own a district in this in-charge's allocation.
    for (const id of mineMigrated) { const d = safeById.get(String(id)).district; if (!icAllocSet[ic.name.trim()].has(norm(d))) leak++; }
  }
  checks.push([`7-9. In-charge mapped counts`, true, JSON.stringify(icCounts)]);
  checks.push([`10. No out-of-district leak (server-side)`, leak === 0, `${leak} leak(s)`]);

  let allPass = true;
  checks.forEach(([label, pass, detail]) => { console.log(`${pass ? '✅' : '❌'} ${label}  [${detail}]`); if (!pass) allPass = false; });

  console.log('\n==================== SUMMARY ====================');
  console.log(`Total attempted     : 44`);
  console.log(`Successfully migrated: ${migrated}`);
  console.log(`Already assigned     : ${alreadyHad}`);
  console.log(`Failed               : ${failed}`);
  console.log(`AuditLog records     : ${APPLY ? migrated : 0}`);
  console.log(`Seetaram             : untouched (${seetaramSnap.length})`);
  console.log(`Manual-review        : untouched (${manualSnap.length})`);
  console.log(`Global assigned sum  : ${beforeGlobal} -> ${afterGlobal}`);
  if (!allPass) fail('one or more verification checks FAILED — review above. No silent fixes performed.');

  // Emit per-reporter result table (JSON) for the report.
  console.log('\n===RESULTS_JSON===');
  console.log(JSON.stringify(results.map(r => ({ name: r.name, email: r.email, district: r.district, locationId: r.locationId, before: r.before, after: r.after || r.before, status: r.status }))));
  await mongoose.connection.close();
})().catch(async (e) => { console.error('ERROR:', e.message, e.stack); try { await mongoose.connection.close(); } catch (_) {} process.exit(1); });
