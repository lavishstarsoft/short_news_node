/**
 * Fix AP/TG district entries to the official structure:
 *
 * RENAME (city entry -> official district):
 *   Machilipatnam -> Krishna   (KRS, కృష్ణా)
 *   Ongole        -> Prakasam  (PKM, ప్రకాశం)
 *   ("Machilipatnam Constituency"/"Ongole Constituency" revert to plain names)
 *
 * DELETE (wrong city/legacy entries):
 *   Vijayawada, Rajahmundry, Markapuram, Tirupati Rural, Warangal Rural
 *
 * MIGRATE references (News.location, Admin.location, Admin.assignedDistricts,
 * constituency parentName) so nothing breaks.
 *
 * Run: node scripts/fix-telugu-districts.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Location = require('../models/Location');
const News = require('../models/News');
const Admin = require('../models/Admin');

// old district name -> new value for news/reporter references
const MIGRATE = {
  'Vijayawada': 'NTR',
  'Rajahmundry': 'East Godavari',
  'Markapuram': 'Markapur',          // Markapur constituency (Prakasam)
  'Tirupati Rural': 'Tirupati',
  'Warangal Rural': 'Warangal',
  'Machilipatnam': 'Machilipatnam',  // becomes constituency name (Krishna)
  'Ongole': 'Ongole'                 // becomes constituency name (Prakasam)
};

const RENAMES = [
  { from: 'Machilipatnam', to: 'Krishna', code: 'KRS', telugu: 'కృష్ణా', acRevert: 'Machilipatnam', acTelugu: 'మచిలీపట్నం' },
  { from: 'Ongole', to: 'Prakasam', code: 'PKM', telugu: 'ప్రకాశం', acRevert: 'Ongole', acTelugu: 'ఒంగోలు' }
];

const DELETES = ['Vijayawada', 'Rajahmundry', 'Markapuram', 'Tirupati Rural', 'Warangal Rural'];

async function migrateRefs(oldName, newName) {
  if (oldName === newName) return;
  const news = await News.updateMany({ location: oldName }, { $set: { location: newName } });
  const reps = await Admin.updateMany({ location: oldName }, { $set: { location: newName } });
  const assigned = await Admin.updateMany(
    { assignedDistricts: oldName },
    { $set: { 'assignedDistricts.$[el]': newName } },
    { arrayFilters: [{ el: oldName }] }
  );
  console.log(`  refs "${oldName}" -> "${newName}": news=${news.modifiedCount}, reporterLoc=${reps.modifiedCount}, assignedDistricts=${assigned.modifiedCount}`);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/shortnews');
  console.log('Connected to MongoDB\n');

  // ---- 1) Renames: Machilipatnam->Krishna, Ongole->Prakasam ----
  for (const r of RENAMES) {
    const district = await Location.findOne({ name: r.from, locationType: 'district' });
    if (!district) { console.log(`! District "${r.from}" not found — skip`); continue; }
    const clash = await Location.findOne({ name: r.to });
    if (clash) { console.log(`! "${r.to}" already exists — skip rename`); continue; }

    district.name = r.to;
    district.teluguName = r.telugu;
    district.localName = r.telugu;
    if (!(await Location.findOne({ code: r.code }))) district.code = r.code;
    await district.save();
    console.log(`✓ District renamed: ${r.from} -> ${r.to}`);

    // Constituencies point to the new district name
    const kids = await Location.updateMany(
      { locationType: 'constituency', parentName: r.from },
      { $set: { parentName: r.to } }
    );
    console.log(`  constituencies re-parented: ${kids.modifiedCount}`);

    // "X Constituency" workaround name revert (district name ippudu free)
    const ac = await Location.findOne({ name: `${r.acRevert} Constituency`, locationType: 'constituency' });
    if (ac) {
      ac.name = r.acRevert;
      ac.teluguName = r.acTelugu;
      ac.localName = r.acTelugu;
      await ac.save();
      console.log(`  constituency renamed back: "${r.acRevert} Constituency" -> "${r.acRevert}"`);
    }

    // Old district tag news -> constituency name (same string, resolves via constituency now)
    await migrateRefs(r.from, MIGRATE[r.from]);
  }

  // ---- 2) Deletes: wrong city/legacy district entries ----
  for (const name of DELETES) {
    const district = await Location.findOne({ name, locationType: 'district' });
    if (!district) { console.log(`! "${name}" not found — skip`); continue; }

    await migrateRefs(name, MIGRATE[name]);

    const kids = await Location.countDocuments({ parentName: name });
    if (kids > 0) {
      console.log(`! "${name}" has ${kids} children — NOT deleting (check manually)`);
      continue;
    }
    await Location.deleteOne({ _id: district._id });
    console.log(`✓ District deleted: ${name}`);
  }

  // ---- 3) Verify ----
  const apDistricts = await Location.find({ locationType: 'district', parentName: 'Andhra Pradesh' }).select('name').lean();
  const tgDistricts = await Location.find({ locationType: 'district', parentName: 'Telangana' }).select('name').lean();
  console.log(`\nAP districts: ${apDistricts.length} (expected 26)`);
  console.log(apDistricts.map((d) => d.name).sort().join(', '));
  console.log(`\nTG districts: ${tgDistricts.length} (expected 33)`);
  console.log(tgDistricts.map((d) => d.name).sort().join(', '));

  const orphans = await Location.aggregate([
    { $match: { locationType: 'constituency' } },
    { $group: { _id: '$parentName', c: { $sum: 1 } } },
    {
      $lookup: {
        from: 'locations',
        let: { p: '$_id' },
        pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$name', '$$p'] }, { $eq: ['$locationType', 'district'] }] } } }],
        as: 'parent'
      }
    },
    { $match: { parent: { $size: 0 } } }
  ]);
  console.log('\nOrphan constituencies (parent leni):', orphans.length ? JSON.stringify(orphans) : 'NONE ✓');

  await mongoose.disconnect();
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
