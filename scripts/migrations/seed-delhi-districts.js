'use strict';

/**
 * SEED DELHI DISTRICTS + assign the Delhi division to its State In-Charge.
 *
 * WHY (senior decision, owner-delegated):
 *  - The Location master has only 4 NCR districts under Delhi (Faridabad,
 *    Gautam Buddha Nagar, Ghaziabad, Gurugram) and NONE of Delhi city's own
 *    districts, so the Delhi In-Charge cannot request assignments or divide
 *    districts for the city, and a real reporter (Shahdara) matches nothing.
 *  - We seed the OFFICIAL 11 Delhi districts (covers all areas the In-Charge
 *    listed — "Old Delhi/Outer North/Central North" are areas inside these).
 *  - NCR stays under Delhi exactly as-is (already the company's setup; verified
 *    NO UP/Haryana in-charge holds these districts → zero conflict).
 *  - Delhi has exactly ONE State In-Charge, so ALL Delhi districts (4 NCR + 11
 *    city = 15) are auto-assigned to her division. If a second Delhi in-charge
 *    ever exists at run time, auto-assign is SKIPPED with a warning (no guessing).
 *
 * MODES:
 *   node scripts/migrations/seed-delhi-districts.js             → DRY RUN (zero writes)
 *   node scripts/migrations/seed-delhi-districts.js --apply     → seed + assign
 *   node scripts/migrations/seed-delhi-districts.js --rollback  → remove ONLY the
 *        districts this script seeded (skips any that have news) and restore the
 *        in-charge's division to the pre-existing NCR-only list.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const DELHI_DISTRICTS = [
  { name: 'Central Delhi',     code: 'DL-C',  localName: 'मध्य दिल्ली',          lat: 28.65, lng: 77.23 },
  { name: 'East Delhi',        code: 'DL-E',  localName: 'पूर्वी दिल्ली',         lat: 28.62, lng: 77.29 },
  { name: 'New Delhi',         code: 'DL-ND', localName: 'नई दिल्ली',            lat: 28.61, lng: 77.21 },
  { name: 'North Delhi',       code: 'DL-N',  localName: 'उत्तरी दिल्ली',         lat: 28.71, lng: 77.20 },
  { name: 'North East Delhi',  code: 'DL-NE', localName: 'उत्तर पूर्वी दिल्ली',    lat: 28.72, lng: 77.28 },
  { name: 'North West Delhi',  code: 'DL-NW', localName: 'उत्तर पश्चिमी दिल्ली',   lat: 28.72, lng: 77.09 },
  { name: 'Shahdara',          code: 'DL-SH', localName: 'शाहदरा',               lat: 28.69, lng: 77.29 },
  { name: 'South Delhi',       code: 'DL-S',  localName: 'दक्षिणी दिल्ली',        lat: 28.53, lng: 77.21 },
  { name: 'South East Delhi',  code: 'DL-SE', localName: 'दक्षिण पूर्वी दिल्ली',   lat: 28.55, lng: 77.26 },
  { name: 'South West Delhi',  code: 'DL-SW', localName: 'दक्षिण पश्चिमी दिल्ली',  lat: 28.58, lng: 77.03 },
  { name: 'West Delhi',        code: 'DL-W',  localName: 'पश्चिमी दिल्ली',        lat: 28.66, lng: 77.06 },
];

async function main() {
  const APPLY = process.argv.includes('--apply');
  const ROLLBACK = process.argv.includes('--rollback');
  console.log(`\n══════ DELHI DISTRICTS SEED — MODE: ${ROLLBACK ? 'ROLLBACK' : APPLY ? 'APPLY' : 'DRY RUN'} ══════`);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const Locations = db.collection('locations');
  const Admins = db.collection('admins');

  const delhi = await Locations.findOne({ locationType: 'state', name: 'Delhi' });
  if (!delhi) { console.error('FATAL: Delhi state not found in Location master.'); process.exit(1); }

  const existing = await Locations.find({ locationType: 'district', parentName: 'Delhi' }).project({ name: 1, newsCount: 1 }).toArray();
  const existingNames = existing.map((d) => d.name);
  console.log(`Delhi districts already in master (${existingNames.length}): ${existingNames.join(', ')}`);

  if (ROLLBACK) {
    let removed = 0;
    for (const d of DELHI_DISTRICTS) {
      const doc = await Locations.findOne({ locationType: 'district', parentName: 'Delhi', name: d.name });
      if (!doc) continue;
      if ((doc.newsCount || 0) > 0) { console.log(`  SKIP ${d.name} — has news (${doc.newsCount}); not deleting.`); continue; }
      await Locations.deleteOne({ _id: doc._id }); removed++;
    }
    const ncrOnly = existingNames.filter((n) => !DELHI_DISTRICTS.some((d) => d.name === n));
    await Admins.updateOne({ name: /kamini jha/i, role: 'subeditor' }, { $set: { 'permissions.managedDistricts': ncrOnly } });
    console.log(`Rolled back: ${removed} seeded districts removed; in-charge division reset to NCR-only.`);
    await mongoose.disconnect(); return;
  }

  // 1. Seed missing districts (idempotent).
  const toAdd = DELHI_DISTRICTS.filter((d) => !existingNames.some((n) => n.trim().toLowerCase() === d.name.toLowerCase()));
  console.log(`\nWill add ${toAdd.length} city districts: ${toAdd.map((d) => d.name).join(', ') || '(none — already seeded)'}`);
  if (APPLY) {
    for (const d of toAdd) {
      await Locations.insertOne({
        name: d.name, code: d.code, locationType: 'district',
        parent: delhi._id, parentName: 'Delhi',
        coordinates: { lat: d.lat, lng: d.lng },
        languages: ['hi', 'en'], localName: d.localName,
        administrativeState: 'Delhi',
        isActive: true, newsCount: 0,
        createdAt: new Date(), updatedAt: new Date(), __v: 0,
      });
    }
  }

  // 2. Assign the FULL Delhi division to its (single) State In-Charge.
  const allDelhi = [...new Set([...existingNames, ...DELHI_DISTRICTS.map((d) => d.name)])].sort();
  const sicRole = await db.collection('roles').findOne({ name: 'State In-Charge' });
  const delhiSics = await Admins.find({
    role: 'subeditor', isActive: { $ne: false },
    ...(sicRole ? { roleIds: sicRole._id } : {}),
    $or: [{ assignedState: 'Delhi' }, { assignedStates: 'Delhi' }],
  }).project({ name: 1 }).toArray();

  if (delhiSics.length === 1) {
    console.log(`\nDelhi In-Charge: ${delhiSics[0].name} → division ${APPLY ? 'set to' : 'would be set to'} all ${allDelhi.length} districts:`);
    console.log('  ' + allDelhi.join(', '));
    if (APPLY) {
      await Admins.updateOne({ _id: delhiSics[0]._id }, { $set: { 'permissions.managedDistricts': allDelhi } });
    }
  } else {
    console.log(`\n⚠️ Delhi has ${delhiSics.length} State In-Charges — auto-assign SKIPPED (divide manually on the District Division page).`);
  }

  if (APPLY) {
    try {
      await db.collection('auditlogs').insertOne({
        actorName: 'script:seed-delhi-districts', actorRole: 'system',
        action: 'locations_delhi_districts_seed', entityType: 'Location', entityId: 'bulk',
        description: `Seeded ${toAdd.length} Delhi city districts; division (${allDelhi.length}) assigned to ${delhiSics.length === 1 ? delhiSics[0].name : 'nobody (multiple SICs)'}`,
        before: { districts: existingNames }, after: { districts: allDelhi },
        ip: '', createdAt: new Date(),
      });
    } catch (e) { console.error('audit failed (non-blocking):', e.message); }
    console.log(`\nAPPLY complete.`);
  } else {
    console.log('\nDRY RUN — zero writes.');
  }
  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
