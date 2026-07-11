/**
 * Seed utility: Indian states & districts with coordinates and languages.
 *
 * Usage:
 *   node utils/seedLocations.js          → seeds only MISSING locations (safe for production)
 *   node utils/seedLocations.js --force  → drops all locations and re-seeds
 *
 * Safe to run multiple times — existing locations are updated with hierarchy fields.
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { INDIA_STATES, TELANGANA_DISTRICTS, AP_DISTRICTS } = require('./locationSeedData');

async function upsertDistrict(Location, district, parentStateName, stateDoc) {
  const exists = await Location.findOne({ $or: [{ code: district.code }, { name: district.name }] });
  if (exists) {
    exists.locationType = 'district';
    exists.parentName = parentStateName;
    exists.parent = stateDoc ? stateDoc._id : null;
    exists.localName = exists.localName || district.localName;
    exists.teluguName = exists.teluguName || district.localName;
    if (!exists.coordinates?.lat) {
      exists.coordinates = { lat: district.lat, lng: district.lng };
    }
    if (!exists.languages?.length) exists.languages = ['te', 'en'];
    await exists.save();
    return 'updated';
  }

  await Location.create({
    name: district.name,
    localName: district.localName,
    teluguName: district.localName,
    code: district.code,
    locationType: 'district',
    parent: stateDoc ? stateDoc._id : null,
    parentName: parentStateName,
    coordinates: { lat: district.lat, lng: district.lng },
    languages: ['te', 'en'],
    isActive: true,
  });
  return 'created';
}

async function seed() {
  const force = process.argv.includes('--force');

  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/shortnews';
  await mongoose.connect(mongoUri);
  console.log('✅ Connected to MongoDB');

  const Location = require('../models/Location');

  if (force) {
    await Location.deleteMany({});
    console.log('🗑️  Cleared all locations (--force)');
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const s of INDIA_STATES) {
    const exists = await Location.findOne({ $or: [{ code: s.code }, { name: s.name }] });
    if (exists) {
      exists.locationType = 'state';
      exists.parent = null;
      exists.parentName = null;
      exists.localName = exists.localName || s.localName;
      exists.teluguName = exists.teluguName || s.localName;
      exists.code = exists.code || s.code;
      if (!exists.coordinates?.lat) exists.coordinates = { lat: s.lat, lng: s.lng };
      if (!exists.languages?.length) exists.languages = s.languages;
      await exists.save();
      skipped++;
      continue;
    }
    await Location.create({
      name: s.name,
      localName: s.localName,
      teluguName: s.localName,
      code: s.code,
      locationType: 'state',
      parent: null,
      parentName: null,
      coordinates: { lat: s.lat, lng: s.lng },
      languages: s.languages,
      isActive: true,
    });
    created++;
  }
  console.log(`📍 States: ${created} created, ${skipped} updated (already exist)`);

  const tsState = await Location.findOne({ $or: [{ code: 'TS' }, { name: 'Telangana' }] });
  created = 0; updated = 0;
  for (const d of TELANGANA_DISTRICTS) {
    const result = await upsertDistrict(Location, d, 'Telangana', tsState);
    if (result === 'created') created++;
    else updated++;
  }
  console.log(`📍 Telangana districts: ${created} created, ${updated} updated`);

  const apState = await Location.findOne({ $or: [{ code: 'AP' }, { name: 'Andhra Pradesh' }] });
  created = 0; updated = 0;
  for (const d of AP_DISTRICTS) {
    const result = await upsertDistrict(Location, d, 'Andhra Pradesh', apState);
    if (result === 'created') created++;
    else updated++;
  }
  console.log(`📍 AP districts: ${created} created, ${updated} updated`);

  console.log('\n✅ Seed complete!');
  console.log('💡 Tip: run node utils/migrateLocationsHierarchy.js to move old flat districts under states.');
  await mongoose.disconnect();
}

seed().catch(err => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
