'use strict';

/**
 * seed-uttarakhand-districts.js — add the 13 official Uttarakhand districts,
 * mirroring the exact seed-up-districts.js pattern (locationType:'district',
 * parent=Uttarakhand _id, parentName='Uttarakhand', unique code, isActive:true).
 *
 * IDEMPOTENT + SAFE: match by (name, district) case-insensitive — re-running never
 * duplicates, never renames existing rows, never changes codes, and touches NO other
 * state. Reconciles parent linkage only when a matching district's parent is wrong
 * AND its parentName is null or already Uttarakhand. Codes are collision-checked
 * against the global unique `code` index.
 *
 *   node seed-uttarakhand-districts.js
 */

require('dotenv').config({ path: __dirname + '/.env' });
const mongoose = require('mongoose');
const Location = require('./models/Location');

const STATE_NAME = 'Uttarakhand';

// Official 13 Uttarakhand districts, [canonical name, preferred unique 3-letter code].
const DISTRICTS = [
  ['Almora', 'ALM'], ['Bageshwar', 'BGW'], ['Chamoli', 'CML'], ['Champawat', 'CPT'], ['Dehradun', 'DDN'],
  ['Haridwar', 'HDW'], ['Nainital', 'NNT'], ['Pauri Garhwal', 'PGW'], ['Pithoragarh', 'PTG'], ['Rudraprayag', 'RDP'],
  ['Tehri Garhwal', 'TGW'], ['Udham Singh Nagar', 'USN'], ['Uttarkashi', 'UTK']
];

// Return a globally-unique code, starting from `preferred` (code has a unique index).
async function freeCode(preferred) {
  const base = String(preferred).toUpperCase();
  if (!(await Location.exists({ code: base }))) return base;
  for (let i = 2; i <= 9; i++) { const c = base.slice(0, 2) + i; if (!(await Location.exists({ code: c }))) return c; }
  for (let i = 10; i <= 99; i++) { const c = 'U' + i; if (!(await Location.exists({ code: c }))) return c; }
  throw new Error('No free code available for ' + preferred);
}

async function run() {
  if (DISTRICTS.length !== 13) throw new Error(`Expected 13 districts, list has ${DISTRICTS.length}`);
  await mongoose.connect(process.env.MONGODB_URI);

  const state = await Location.findOne({ name: STATE_NAME, locationType: 'state' });
  if (!state) throw new Error(`State "${STATE_NAME}" not found — aborting.`);

  let inserted = 0, existing = 0, reconciled = 0;
  for (const [name, code] of DISTRICTS) {
    const found = await Location.findOne({
      name: { $regex: new RegExp(`^${name}$`, 'i') },
      locationType: 'district'
    });

    if (found) {
      const needsFix = String(found.parent) !== String(state._id) || found.parentName !== STATE_NAME;
      if (needsFix && (found.parentName == null || found.parentName === STATE_NAME)) {
        found.parent = state._id;
        found.parentName = STATE_NAME;
        found.isActive = true;
        await found.save();
        reconciled++;
        console.log(`  ~ reconciled parent: ${name}`);
      } else {
        existing++;
      }
      continue;
    }

    const useCode = await freeCode(code);
    await Location.create({
      name: name.trim(),
      code: useCode,
      locationType: 'district',
      parent: state._id,
      parentName: STATE_NAME,
      isActive: true
    });
    inserted++;
    console.log(`  + inserted: ${name} [${useCode}]`);
  }

  const finalCount = await Location.countDocuments({ locationType: 'district', parentName: STATE_NAME, parent: state._id });
  console.log(`Inserted: ${inserted} | Already present: ${existing} | Reconciled: ${reconciled}`);
  console.log(`FINAL Uttarakhand district count: ${finalCount}`);
  if (finalCount !== 13) throw new Error(`Count mismatch: expected 13, got ${finalCount}`);
  console.log('✅ Verified: exactly 13 Uttarakhand districts, correctly linked to Uttarakhand.');

  await mongoose.disconnect();
}

run().catch((e) => { console.error('❌', e.message); process.exit(1); });
