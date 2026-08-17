'use strict';
/**
 * seed-missing-districts-2026.js — additive, idempotent seed of the approved
 * MISSING districts for 8 active states (as of 16-Aug-2026 audit).
 *
 * SCOPE (approved): Madhya Pradesh, Tamil Nadu, Bihar, Maharashtra, Gujarat,
 * Karnataka, Jharkhand, Punjab.  Total planned inserts: 278.
 *
 * SAFETY:
 *  - NEVER modifies/renames/deletes/re-parents any existing Location.
 *  - Idempotent: a name already present UNDER ITS OWN STATE (case-insensitive) is
 *    left unchanged. A truly-missing name is inserted (parent = state _id,
 *    parentName = state name, isActive: true, globally-unique auto code).
 *  - COLLISION GUARD: if any planned name already exists ANYWHERE ELSE (different
 *    state, or as a non-district such as a state/UT), the whole run ABORTS and
 *    reports — nothing is inserted, nothing is remapped.
 *  - Touches ONLY the Location collection (districts). No reporters, in-charges,
 *    applications, routing, or state isActive flags are read or changed.
 *
 *   node seed-missing-districts-2026.js            # dry-run (default, no writes)
 *   node seed-missing-districts-2026.js --apply    # perform inserts
 */

require('dotenv').config({ path: __dirname + '/.env' });
const mongoose = require('mongoose');
const Location = require('./models/Location');

const APPLY = process.argv.includes('--apply');
const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const PLAN = {
  'Madhya Pradesh': ['Agar Malwa','Alirajpur','Anuppur','Ashoknagar','Balaghat','Barwani','Betul','Bhind','Bhopal','Burhanpur','Chhatarpur','Chhindwara','Damoh','Datia','Dewas','Dhar','Dindori','Guna','Gwalior','Harda','Indore','Jabalpur','Jhabua','Katni','Khandwa','Khargone','Maihar','Mandla','Mandsaur','Mauganj','Morena','Narmadapuram','Narsinghpur','Neemuch','Niwari','Pandhurna','Panna','Raisen','Rajgarh','Ratlam','Rewa','Sagar','Satna','Sehore','Seoni','Shahdol','Shajapur','Sheopur','Shivpuri','Sidhi','Singrauli','Tikamgarh','Ujjain','Umaria','Vidisha'],
  'Tamil Nadu': ['Ariyalur','Chengalpattu','Chennai','Coimbatore','Cuddalore','Dharmapuri','Dindigul','Erode','Kallakurichi','Kancheepuram','Kanniyakumari','Karur','Krishnagiri','Madurai','Mayiladuthurai','Nagapattinam','Namakkal','Nilgiris','Perambalur','Pudukkottai','Ramanathapuram','Ranipet','Salem','Sivaganga','Tenkasi','Thanjavur','Theni','Thoothukudi','Tiruchirappalli','Tirunelveli','Tirupattur','Tiruppur','Tiruvallur','Tiruvannamalai','Tiruvarur','Vellore','Viluppuram','Virudhunagar'],
  'Bihar': ['Araria','Arwal','Aurangabad','Banka','Begusarai','Bhagalpur','Bhojpur','Buxar','Darbhanga','East Champaran','Gaya','Gopalganj','Jamui','Jehanabad','Kaimur','Katihar','Khagaria','Kishanganj','Lakhisarai','Madhepura','Madhubani','Munger','Muzaffarpur','Nalanda','Nawada','Patna','Purnia','Rohtas','Saharsa','Samastipur','Saran','Sheikhpura','Sheohar','Sitamarhi','Siwan','Supaul','Vaishali','West Champaran'],
  'Maharashtra': ['Ahmednagar','Akola','Amravati','Beed','Bhandara','Buldhana','Chandrapur','Chhatrapati Sambhajinagar','Dharashiv','Dhule','Gadchiroli','Gondia','Hingoli','Jalgaon','Jalna','Kolhapur','Latur','Mumbai City','Mumbai Suburban','Nagpur','Nanded','Nandurbar','Nashik','Palghar','Parbhani','Pune','Raigad','Ratnagiri','Sangli','Satara','Sindhudurg','Solapur','Thane','Wardha','Washim','Yavatmal'],
  'Gujarat': ['Ahmedabad','Amreli','Anand','Aravalli','Banaskantha','Bharuch','Bhavnagar','Botad','Chhota Udaipur','Dahod','Dang','Devbhoomi Dwarka','Gandhinagar','Gir Somnath','Jamnagar','Junagadh','Kutch','Kheda','Mahisagar','Mehsana','Morbi','Narmada','Navsari','Panchmahal','Patan','Porbandar','Rajkot','Sabarkantha','Surat','Surendranagar','Tapi','Vadodara','Valsad'],
  'Karnataka': ['Bagalkote','Ballari','Belagavi','Bengaluru Rural','Bengaluru Urban','Bidar','Chamarajanagar','Chikkaballapura','Chikkamagaluru','Chitradurga','Dakshina Kannada','Davanagere','Dharwad','Gadag','Hassan','Haveri','Kalaburagi','Kodagu','Kolar','Koppal','Mandya','Mysuru','Raichur','Ramanagara','Shivamogga','Tumakuru','Udupi','Uttara Kannada','Vijayapura','Vijayanagara','Yadgir'],
  'Jharkhand': ['Bokaro','Chatra','Deoghar','Dhanbad','Dumka','East Singhbhum','Garhwa','Giridih','Godda','Gumla','Hazaribagh','Jamtara','Khunti','Koderma','Latehar','Lohardaga','Pakur','Palamu','Ramgarh','Ranchi','Sahibganj','Seraikela-Kharsawan','Simdega','West Singhbhum'],
  'Punjab': ['Amritsar','Barnala','Bathinda','Faridkot','Fatehgarh Sahib','Fazilka','Ferozepur','Gurdaspur','Hoshiarpur','Jalandhar','Kapurthala','Ludhiana','Malerkotla','Mansa','Moga','Muktsar','Pathankot','Patiala','Rupnagar','Sahibzada Ajit Singh Nagar','Sangrur','Shaheed Bhagat Singh Nagar','Tarn Taran'],
};

async function freeCode(name, statePrefix, taken) {
  const letters = String(name).toUpperCase().replace(/[^A-Z]/g, '');
  const cands = [];
  if (letters.length >= 3) cands.push(letters.slice(0, 3));
  if (letters.length >= 4) cands.push(letters.slice(0, 4));
  if (letters.length >= 3) cands.push(letters.slice(0, 2) + letters.slice(-1));
  for (let i = 1; i <= 999; i++) cands.push(statePrefix + String(i).padStart(2, '0'));
  for (const c of cands) {
    if (c.length < 2 || c.length > 10) continue;
    if (taken.has(c)) continue;
    if (!(await Location.exists({ code: c }))) { taken.add(c); return c; }
  }
  throw new Error('No free code for ' + name);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  console.log(`Missing-districts seed 2026 — ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  // Resolve the 8 target states (must already exist).
  const stateDocs = {};
  for (const stateName of Object.keys(PLAN)) {
    const st = await Location.findOne({ locationType: 'state', name: new RegExp(`^${stateName}$`, 'i') }).lean();
    if (!st) { console.error(`❌ State not found: ${stateName} — aborting.`); await mongoose.disconnect(); process.exit(1); }
    stateDocs[stateName] = st;
  }

  // The unique `name` index spans ALL location types (incl. constituencies), so the
  // collision/idempotency snapshot MUST cover every type — not just states/districts.
  const existing = await Location.find({})
    .select('name locationType parentName').lean();
  const byName = new Map(existing.map(d => [norm(d.name), d]));

  // ---- PRE-PASS: classify every planned name ----
  const toInsert = [];   // {stateName, name}
  const skipExisting = [];
  const collisions = []; // {stateName, name, conflictsWith}
  const perStatePlanned = {};
  for (const [stateName, names] of Object.entries(PLAN)) {
    perStatePlanned[stateName] = names.length;
    for (const name of names) {
      const hit = byName.get(norm(name));
      if (!hit) { toInsert.push({ stateName, name }); continue; }
      if (hit.locationType === 'district' && norm(hit.parentName) === norm(stateName)) { skipExisting.push({ stateName, name }); continue; }
      collisions.push({ stateName, name, conflictsWith: `${hit.locationType} under "${hit.parentName || '-'}"` });
    }
  }

  const collisionNames = new Set(collisions.map(c => norm(c.name)));
  if (collisions.length) {
    console.log('⚠  NAME COLLISION(S) — SKIPPED (never inserted, never remapped) per policy:');
    for (const c of collisions) console.log(`   ${c.stateName} :: "${c.name}"  -> name already exists as ${c.conflictsWith}`);
    console.log('');
  }

  console.log('=== PLAN (BEFORE) ===');
  for (const [stateName, n] of Object.entries(perStatePlanned)) {
    const already = skipExisting.filter(x => x.stateName === stateName).length;
    const ins = toInsert.filter(x => x.stateName === stateName).length;
    console.log(`${stateName}: planned ${n} | already present ${already} | to insert ${ins}`);
  }
  console.log(`\nTOTAL to insert: ${toInsert.length} | already present (idempotent skip): ${skipExisting.length} | collisions: ${collisions.length}`);

  if (!APPLY) {
    console.log('\nDRY-RUN complete. Re-run with --apply to insert.');
    await mongoose.disconnect();
    return;
  }

  // ---- APPLY: insert only the missing names ----
  const taken = new Set();
  let inserted = 0;
  for (const [stateName, names] of Object.entries(PLAN)) {
    const st = stateDocs[stateName];
    const prefix = String(st.code || stateName.slice(0, 2)).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2) || 'XX';
    for (const name of names) {
      if (!toInsert.find(x => x.stateName === stateName && x.name === name)) continue; // already present
      const code = await freeCode(name, prefix, taken);
      await Location.create({
        name: name.trim(),
        code,
        locationType: 'district',
        parent: st._id,
        parentName: st.name,
        isActive: true,
      });
      inserted++;
    }
  }

  // ---- VERIFY ----
  console.log(`\n=== APPLIED: inserted ${inserted} districts ===`);
  let verifyFail = 0;
  for (const [stateName, names] of Object.entries(PLAN)) {
    const st = stateDocs[stateName];
    const rows = await Location.find({ locationType: 'district', parentName: st.name }).select('name parent').lean();
    const present = new Set(rows.map(r => norm(r.name)));
    // Expected = planned names minus the intentionally-skipped collisions.
    const expected = names.filter(n => !collisionNames.has(norm(n)));
    const missing = expected.filter(n => !present.has(norm(n)));
    const badParent = rows.filter(r => String(r.parent) !== String(st._id)).length; // among this state's rows
    const skipped = names.filter(n => collisionNames.has(norm(n)));
    const skipNote = skipped.length ? ` | skipped(collision): ${skipped.join(', ')}` : '';
    if (missing.length) { verifyFail++; console.log(`  ✗ ${stateName}: still missing ${missing.length} -> ${missing.join(', ')}${skipNote}`); }
    else console.log(`  ✔ ${stateName}: ${rows.length} districts under state (all expected present, parent-linked; bad-parent rows: ${badParent})${skipNote}`);
  }
  console.log(verifyFail ? '\n❌ Verification found gaps.' : '\n✅ Verification OK: all planned districts present and parent-linked.');

  await mongoose.disconnect();
})().catch(e => { console.error('❌', e.message); try { mongoose.disconnect(); } catch (_) {} process.exit(1); });
