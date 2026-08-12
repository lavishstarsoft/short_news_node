'use strict';

/**
 * migrate-delhi-4.js — EMERGENCY, SCOPED migration for exactly 4 districts.
 *
 * Moves into the app hierarchy under "Delhi":
 *   - Ghaziabad            (reparent: Uttar Pradesh -> Delhi, keep administrativeState=Uttar Pradesh)
 *   - Gautam Buddha Nagar  (reparent: Uttar Pradesh -> Delhi, keep administrativeState=Uttar Pradesh)
 *   - Faridabad            (create under Delhi, administrativeState=Haryana, isActive:true)
 *   - Gurugram             (create under Delhi, administrativeState=Haryana, isActive:true)
 *
 * SAFE + IDEMPOTENT:
 *   - District NAMES and CODES are never changed -> News.location strings and
 *     reporter assignedDistricts/managedDistricts (name-based matching) stay valid.
 *   - Only parentName/parent (+ additive administrativeState) change on the 2 UP rows.
 *   - Re-running is a no-op (upsert by name; reparent only if not already Delhi).
 *   - NO other NCR district / user / permission is touched.
 *
 * Run:  node migrate-delhi-4.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Location = require('./models/Location');

const NEW_PARENT = 'Delhi';
const REPARENT = [
  { name: 'Ghaziabad', administrativeState: 'Uttar Pradesh' },
  { name: 'Gautam Buddha Nagar', administrativeState: 'Uttar Pradesh' }
];
const CREATE = [
  { name: 'Faridabad', code: 'FBD', administrativeState: 'Haryana' },
  { name: 'Gurugram', code: 'GGN', administrativeState: 'Haryana' }
];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);

  const delhi = await Location.findOne({ name: 'Delhi', locationType: 'state' });
  if (!delhi) throw new Error('Parent "Delhi" (state) not found — aborting, no changes made.');

  // ---- BEFORE snapshot ----
  const before = {};
  for (const n of ['Ghaziabad', 'Gautam Buddha Nagar', 'Faridabad', 'Gurugram']) {
    const d = await Location.findOne({ name: n }).select('name locationType parentName administrativeState code isActive').lean();
    before[n] = d || null;
  }
  console.log('BEFORE:', JSON.stringify(before, null, 1));

  let reparented = 0, created = 0, skipped = 0;

  // ---- Reparent the 2 existing UP districts (name/code untouched) ----
  for (const { name, administrativeState } of REPARENT) {
    const doc = await Location.findOne({ name, locationType: 'district' });
    if (!doc) { console.warn(`! ${name} not found as district — skipped`); skipped++; continue; }
    if (String(doc.parentName) === NEW_PARENT && doc.administrativeState === administrativeState) {
      skipped++; continue; // already migrated
    }
    doc.parentName = NEW_PARENT;
    doc.parent = delhi._id;
    doc.administrativeState = administrativeState;
    await doc.save();
    reparented++;
  }

  // ---- Create the 2 missing Haryana districts under Delhi (idempotent) ----
  for (const { name, code, administrativeState } of CREATE) {
    const existing = await Location.findOne({ name });
    if (existing) {
      // Ensure it points to Delhi (in case of a prior partial run); never rename.
      const needsFix = existing.parentName !== NEW_PARENT || existing.administrativeState !== administrativeState || existing.isActive === false;
      if (needsFix) {
        existing.parentName = NEW_PARENT;
        existing.parent = delhi._id;
        existing.administrativeState = administrativeState;
        existing.isActive = true;
        existing.locationType = 'district';
        await existing.save();
        reparented++;
      } else skipped++;
      continue;
    }
    // code collision guard
    if (await Location.findOne({ code })) throw new Error(`Code "${code}" already in use — aborting before creating ${name}.`);
    await Location.create({
      name,
      code,
      locationType: 'district',
      parent: delhi._id,
      parentName: NEW_PARENT,
      administrativeState,
      isActive: true
    });
    created++;
  }

  console.log(`\nApplied — reparented/updated: ${reparented}, created: ${created}, skipped(no-op): ${skipped}`);

  // ---- AFTER verification ----
  const after = {};
  for (const n of ['Ghaziabad', 'Gautam Buddha Nagar', 'Faridabad', 'Gurugram']) {
    const d = await Location.findOne({ name: n }).select('name locationType parentName administrativeState code isActive').lean();
    after[n] = d;
  }
  console.log('\nAFTER:', JSON.stringify(after, null, 1));

  const delhiDistricts = (await Location.find({ locationType: 'district', parentName: 'Delhi', isActive: true }).select('name').lean()).map(d => d.name).sort();
  const upHas = await Location.countDocuments({ locationType: 'district', parentName: 'Uttar Pradesh', name: { $in: ['Ghaziabad', 'Gautam Buddha Nagar'] } });
  const hrHas = await Location.countDocuments({ locationType: 'district', parentName: 'Haryana', name: { $in: ['Faridabad', 'Gurugram'] } });
  const upCount = await Location.countDocuments({ locationType: 'district', parentName: 'Uttar Pradesh' });

  console.log('\n--- VERIFY ---');
  console.log('Delhi districts now:', delhiDistricts.join(', '));
  console.log('UP still has Ghaziabad/GB Nagar? (want 0):', upHas);
  console.log('Haryana has Faridabad/Gurugram? (want 0):', hrHas);
  console.log('UP district count now:', upCount);

  const the4Ok = ['Ghaziabad', 'Gautam Buddha Nagar', 'Faridabad', 'Gurugram'].every(n => after[n] && after[n].parentName === 'Delhi' && after[n].isActive === true);
  if (!the4Ok || upHas !== 0 || hrHas !== 0) throw new Error('Verification FAILED — check output.');
  console.log('\n✅ All 4 under Delhi; removed from UP/Haryana; names & codes unchanged.');

  await mongoose.disconnect();
}

run().catch((e) => { console.error('❌', e.message); process.exit(1); });
