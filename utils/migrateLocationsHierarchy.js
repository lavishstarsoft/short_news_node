/**
 * Migrate old flat locations into the hierarchy (State → District).
 *
 * SAFE for production / old Flutter app:
 * - Does NOT rename or delete any location
 * - Does NOT change location `name` (news.location strings stay valid)
 * - Only updates locationType, parentName, parent, localName metadata
 *
 * Usage:
 *   node utils/migrateLocationsHierarchy.js
 *   node utils/migrateLocationsHierarchy.js --dry-run
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

// Re-use seed mappings
const { INDIA_STATES, TELANGANA_DISTRICTS, AP_DISTRICTS } = require('./locationSeedData');

/** Old dashboard entries that are news scope, not geography */
const SCOPE_LOCATIONS = new Set(['National', 'International']);

/** Extra legacy district → state mappings (old flat names) */
const LEGACY_DISTRICT_PARENT = {
  'East Godavari': 'Andhra Pradesh',
  'West Godavari': 'Andhra Pradesh',
  Markapuram: 'Andhra Pradesh',
  Mumbai: 'Maharashtra',
  NTR: 'Andhra Pradesh',
};

function buildDistrictParentMap() {
  const map = new Map();
  for (const d of TELANGANA_DISTRICTS) map.set(d.name, 'Telangana');
  for (const d of AP_DISTRICTS) map.set(d.name, 'Andhra Pradesh');
  for (const [name, state] of Object.entries(LEGACY_DISTRICT_PARENT)) {
    map.set(name, state);
  }
  return map;
}

async function migrate() {
  const dryRun = process.argv.includes('--dry-run');
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/shortnews';

  await mongoose.connect(mongoUri);
  console.log(`✅ Connected to MongoDB${dryRun ? ' (DRY RUN)' : ''}`);

  const Location = require('../models/Location');
  const districtParentMap = buildDistrictParentMap();

  // Ensure all India states have locationType=state
  let statesFixed = 0;
  for (const s of INDIA_STATES) {
    const doc = await Location.findOne({ $or: [{ name: s.name }, { code: s.code }] });
    if (!doc) continue;

    const needsUpdate =
      doc.locationType !== 'state' ||
      doc.parentName ||
      doc.parent;

    if (needsUpdate) {
      console.log(`🏳️  Fix state: ${doc.name}`);
      if (!dryRun) {
        doc.locationType = 'state';
        doc.parent = null;
        doc.parentName = null;
        doc.localName = doc.localName || s.localName;
        doc.teluguName = doc.teluguName || s.localName;
        if (!doc.coordinates?.lat) doc.coordinates = { lat: s.lat, lng: s.lng };
        await doc.save();
      }
      statesFixed++;
    }
  }

  // Move orphan / flat districts under their state
  let districtsMoved = 0;
  let scopesFixed = 0;
  let skipped = 0;

  const all = await Location.find().sort({ name: 1 });

  for (const loc of all) {
    if (SCOPE_LOCATIONS.has(loc.name)) {
      if (loc.locationType !== 'scope') {
        console.log(`🌐 Scope location: ${loc.name} → type=scope (stays top-level)`);
        if (!dryRun) {
          loc.locationType = 'scope';
          loc.parent = null;
          loc.parentName = null;
          await loc.save();
        }
        scopesFixed++;
      }
      continue;
    }

    const parentStateName = districtParentMap.get(loc.name);
    if (!parentStateName) {
      skipped++;
      continue;
    }

    const parentState = await Location.findOne({ name: parentStateName, locationType: 'state' });
    const needsUpdate =
      loc.locationType !== 'district' ||
      loc.parentName !== parentStateName ||
      (parentState && String(loc.parent) !== String(parentState._id));

    if (!needsUpdate) continue;

    console.log(`📍 Move district: ${loc.name} → ${parentStateName}`);
    if (!dryRun) {
      loc.locationType = 'district';
      loc.parentName = parentStateName;
      loc.parent = parentState ? parentState._id : null;

      const seedMeta =
        TELANGANA_DISTRICTS.find(d => d.name === loc.name) ||
        AP_DISTRICTS.find(d => d.name === loc.name);
      if (seedMeta) {
        loc.localName = loc.localName || seedMeta.localName;
        loc.teluguName = loc.teluguName || seedMeta.localName;
        if (!loc.coordinates?.lat) {
          loc.coordinates = { lat: seedMeta.lat, lng: seedMeta.lng };
        }
      }
      await loc.save();
    }
    districtsMoved++;
  }

  console.log('\n📊 Summary');
  console.log(`   States normalized: ${statesFixed}`);
  console.log(`   Districts moved under state: ${districtsMoved}`);
  console.log(`   Scope locations (National/International): ${scopesFixed}`);
  console.log(`   Unmapped (left unchanged): ${skipped}`);
  console.log(dryRun ? '\n⚠️  Dry run — no database writes.' : '\n✅ Migration complete!');

  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
