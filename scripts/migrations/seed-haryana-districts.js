'use strict';

/**
 * SEED HARYANA (+CHANDIGARH) DISTRICTS + assign the division to Tejbir.
 *
 * Senior decisions (owner-delegated, mirrors the approved Delhi pattern):
 *  - Haryana has 0 districts in the Location master → seed the OFFICIAL list,
 *    EXCLUDING Gurugram & Faridabad (they are registered under Delhi-NCR and
 *    belong to the Delhi In-Charge — adding them here would create a two-owner
 *    conflict). → 20 Haryana districts.
 *  - Chandigarh (UT) has 0 districts → seed one "Chandigarh" district so the
 *    In-Charge can operate there too.
 *  - Tejbir is the ONLY State In-Charge for Chandigarh+Haryana → all 21
 *    districts are auto-assigned to his division. If more than one In-Charge is
 *    found at runtime, auto-assign is SKIPPED (no guessing).
 *
 * MODES:  (default DRY RUN — zero writes) | --apply | --rollback
 * Rollback removes only districts seeded here (skips any with news) and clears
 * Tejbir's division.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const HARYANA_DISTRICTS = [
  { name: 'Ambala',        code: 'HR-AM', localName: 'अंबाला',        lat: 30.38, lng: 76.78 },
  { name: 'Bhiwani',       code: 'HR-BH', localName: 'भिवानी',        lat: 28.79, lng: 76.13 },
  { name: 'Charkhi Dadri', code: 'HR-CD', localName: 'चरखी दादरी',    lat: 28.59, lng: 76.27 },
  { name: 'Fatehabad',     code: 'HR-FT', localName: 'फतेहाबाद',      lat: 29.51, lng: 75.45 },
  { name: 'Hisar',         code: 'HR-HI', localName: 'हिसार',         lat: 29.15, lng: 75.72 },
  { name: 'Jhajjar',       code: 'HR-JH', localName: 'झज्जर',         lat: 28.61, lng: 76.66 },
  { name: 'Jind',          code: 'HR-JI', localName: 'जींद',          lat: 29.32, lng: 76.31 },
  { name: 'Kaithal',       code: 'HR-KT', localName: 'कैथल',          lat: 29.80, lng: 76.40 },
  { name: 'Karnal',        code: 'HR-KA', localName: 'करनाल',         lat: 29.69, lng: 76.99 },
  { name: 'Kurukshetra',   code: 'HR-KU', localName: 'कुरुक्षेत्र',     lat: 29.97, lng: 76.85 },
  { name: 'Mahendragarh',  code: 'HR-MA', localName: 'महेंद्रगढ़',      lat: 28.28, lng: 76.15 },
  { name: 'Nuh',           code: 'HR-NU', localName: 'नूंह',           lat: 28.10, lng: 77.00 },
  { name: 'Palwal',        code: 'HR-PL', localName: 'पलवल',          lat: 28.14, lng: 77.33 },
  { name: 'Panchkula',     code: 'HR-PK', localName: 'पंचकुला',        lat: 30.69, lng: 76.85 },
  { name: 'Panipat',       code: 'HR-PA', localName: 'पानीपत',        lat: 29.39, lng: 76.97 },
  { name: 'Rewari',        code: 'HR-RE', localName: 'रेवाड़ी',        lat: 28.20, lng: 76.62 },
  { name: 'Rohtak',        code: 'HR-RO', localName: 'रोहतक',         lat: 28.90, lng: 76.57 },
  { name: 'Sirsa',         code: 'HR-SI', localName: 'सिरसा',         lat: 29.53, lng: 75.03 },
  { name: 'Sonipat',       code: 'HR-SO', localName: 'सोनीपत',        lat: 28.99, lng: 77.02 },
  { name: 'Yamunanagar',   code: 'HR-YN', localName: 'यमुनानगर',      lat: 30.13, lng: 77.28 },
];
// NOTE: cannot be named just "Chandigarh" — the locations collection has a GLOBAL
// unique index on `name`, and "Chandigarh" is already the state document.
const CHANDIGARH_DISTRICTS = [
  { name: 'Chandigarh City', code: 'CH-CH', localName: 'चंडीगढ़ शहर', lat: 30.73, lng: 76.78 },
];

async function seedState(Locations, stateName, defs, APPLY) {
  const state = await Locations.findOne({ locationType: 'state', name: stateName });
  if (!state) { console.log(`⚠️ ${stateName} state not found in master — skipped.`); return []; }
  const existing = (await Locations.find({ locationType: 'district', parentName: stateName }).project({ name: 1 }).toArray()).map((d) => d.name);
  const toAdd = defs.filter((d) => !existing.some((n) => n.trim().toLowerCase() === d.name.toLowerCase()));
  console.log(`${stateName}: existing ${existing.length} | will add ${toAdd.length}: ${toAdd.map((d) => d.name).join(', ') || '(none)'}`);
  const added = [];
  if (APPLY) {
    for (const d of toAdd) {
      // GLOBAL name collision handling: `locations` has a unique index on `name`
      // across ALL types/states. If a same-named UNREFERENCED constituency blocks
      // us (e.g. "Fatehabad" constituency under Agra), rename it "<name> (<parent>)"
      // and proceed. Any other blocker → skip with a clear warning (never crash).
      try {
        const clash = await Locations.findOne({ name: d.name });
        if (clash && clash.locationType === 'constituency') {
          const renamed = `${d.name} (${clash.parentName || 'other'})`;
          await Locations.updateOne({ _id: clash._id }, { $set: { name: renamed, updatedAt: new Date() } });
          console.log(`  renamed blocking constituency: ${d.name} → ${renamed}`);
        } else if (clash) {
          console.log(`  ⚠️ SKIP ${d.name} — name already used by ${clash.locationType} under ${clash.parentName || '—'}`);
          continue;
        }
        await Locations.insertOne({
          name: d.name, code: d.code, locationType: 'district',
          parent: state._id, parentName: stateName,
          coordinates: { lat: d.lat, lng: d.lng },
          languages: ['hi', 'en'], localName: d.localName,
          administrativeState: stateName,
          isActive: true, newsCount: 0,
          createdAt: new Date(), updatedAt: new Date(), __v: 0,
        });
        added.push(d.name);
      } catch (e) {
        console.log(`  ⚠️ SKIP ${d.name} — ${e.message.split(':')[0]}`);
      }
    }
    console.log(`  → inserted ${added.length}/${toAdd.length}`);
  }
  // Division list = what actually exists under this state after seeding.
  const finalNames = (await Locations.find({ locationType: 'district', parentName: stateName }).project({ name: 1 }).toArray()).map((x) => x.name);
  return APPLY ? finalNames : [...new Set([...existing, ...defs.map((d) => d.name)])];
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const ROLLBACK = process.argv.includes('--rollback');
  console.log(`\n══════ HARYANA+CHANDIGARH DISTRICTS SEED — MODE: ${ROLLBACK ? 'ROLLBACK' : APPLY ? 'APPLY' : 'DRY RUN'} ══════`);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const Locations = db.collection('locations');
  const Admins = db.collection('admins');

  if (ROLLBACK) {
    let removed = 0;
    for (const [st, defs] of [['Haryana', HARYANA_DISTRICTS], ['Chandigarh', CHANDIGARH_DISTRICTS]]) {
      for (const d of defs) {
        const doc = await Locations.findOne({ locationType: 'district', parentName: st, name: d.name });
        if (!doc) continue;
        if ((doc.newsCount || 0) > 0) { console.log(`  SKIP ${d.name} — has news.`); continue; }
        await Locations.deleteOne({ _id: doc._id }); removed++;
      }
    }
    await Admins.updateOne({ name: /^Tejbir/i, role: 'subeditor' }, { $set: { 'permissions.managedDistricts': [] } });
    console.log(`Rolled back: ${removed} districts removed; Tejbir division cleared.`);
    await mongoose.disconnect(); return;
  }

  const hr = await seedState(Locations, 'Haryana', HARYANA_DISTRICTS, APPLY);
  const ch = await seedState(Locations, 'Chandigarh', CHANDIGARH_DISTRICTS, APPLY);
  const allDivision = [...hr, ...ch].sort();

  const sicRole = await db.collection('roles').findOne({ name: 'State In-Charge' });
  const sics = await Admins.find({
    role: 'subeditor', isActive: { $ne: false },
    ...(sicRole ? { roleIds: sicRole._id } : {}),
    $or: [{ assignedState: 'Haryana' }, { assignedStates: 'Haryana' }],
  }).project({ name: 1 }).toArray();

  if (sics.length === 1) {
    console.log(`\nIn-Charge: ${sics[0].name} → division ${APPLY ? 'set to' : 'would be set to'} ${allDivision.length} districts (Haryana ${hr.length} + Chandigarh ${ch.length})`);
    if (APPLY) await Admins.updateOne({ _id: sics[0]._id }, { $set: { 'permissions.managedDistricts': allDivision } });
  } else {
    console.log(`\n⚠️ Haryana has ${sics.length} In-Charges — auto-assign SKIPPED.`);
  }

  console.log(`\nNOTE: Gurugram & Faridabad are intentionally NOT added here — they belong to Delhi-NCR (Kamini Jha).`);
  console.log(`NOTE: 2 reporters use town names (Narnaul → Mahendragarh dist, Tohana → Fatehabad dist) — fix their district on the editors page later.`);

  if (APPLY) {
    try {
      await db.collection('auditlogs').insertOne({
        actorName: 'script:seed-haryana-districts', actorRole: 'system',
        action: 'locations_haryana_districts_seed', entityType: 'Location', entityId: 'bulk',
        description: `Seeded Haryana(${hr.length})+Chandigarh(${ch.length}) districts; division → ${sics.length === 1 ? sics[0].name : 'nobody'}`,
        before: null, after: { division: allDivision }, ip: '', createdAt: new Date(),
      });
    } catch (e) { console.error('audit failed (non-blocking):', e.message); }
    console.log('\nAPPLY complete.');
  } else {
    console.log('\nDRY RUN — zero writes.');
  }
  await mongoose.disconnect();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
