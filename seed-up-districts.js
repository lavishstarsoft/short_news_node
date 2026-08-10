'use strict';

/**
 * seed-up-districts.js — add all 75 Uttar Pradesh districts, replicating the exact
 * Telangana district pattern (locationType:'district', parent=UP _id, parentName,
 * unique 3-letter code, isActive:true).
 *
 * IDEMPOTENT + SAFE: upsert by (name, locationType) — re-running never duplicates,
 * never renames existing rows, and touches no other state. Run:
 *
 *   node seed-up-districts.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Location = require('./models/Location');

const STATE_NAME = 'Uttar Pradesh';

// Official 75 UP districts (verified count = 75 as of 2026-08-01). [name, unique code]
const DISTRICTS = [
  ['Agra', 'AGR'], ['Aligarh', 'ALG'], ['Ambedkar Nagar', 'AMB'], ['Amethi', 'AMT'], ['Amroha', 'AMR'],
  ['Auraiya', 'AUR'], ['Ayodhya', 'AYO'], ['Azamgarh', 'AZM'], ['Baghpat', 'BGP'], ['Bahraich', 'BHR'],
  ['Ballia', 'BLL'], ['Balrampur', 'BLR'], ['Banda', 'BND'], ['Barabanki', 'BBK'], ['Bareilly', 'BRL'],
  ['Basti', 'BST'], ['Bhadohi', 'BDH'], ['Bijnor', 'BJN'], ['Budaun', 'BDN'], ['Bulandshahr', 'BLS'],
  ['Chandauli', 'CDL'], ['Chitrakoot', 'CTK'], ['Deoria', 'DEO'], ['Etah', 'ETH'], ['Etawah', 'ETW'],
  ['Farrukhabad', 'FRK'], ['Fatehpur', 'FTP'], ['Firozabad', 'FRZ'], ['Gautam Buddha Nagar', 'GBN'], ['Ghaziabad', 'GZB'],
  ['Ghazipur', 'GZP'], ['Gonda', 'GND'], ['Gorakhpur', 'GKP'], ['Hamirpur', 'HMP'], ['Hapur', 'HPR'],
  ['Hardoi', 'HRD'], ['Hathras', 'HTR'], ['Jalaun', 'JLN'], ['Jaunpur', 'JNP'], ['Jhansi', 'JHS'],
  ['Kannauj', 'KNJ'], ['Kanpur Dehat', 'KND'], ['Kanpur Nagar', 'KNP'], ['Kasganj', 'KSG'], ['Kaushambi', 'KSB'],
  ['Lakhimpur Kheri', 'LKH'], ['Kushinagar', 'KSN'], ['Lalitpur', 'LLP'], ['Lucknow', 'LKO'], ['Maharajganj', 'MHR'],
  ['Mahoba', 'MHB'], ['Mainpuri', 'MNP'], ['Mathura', 'MTH'], ['Mau', 'MAU'], ['Meerut', 'MRT'],
  ['Mirzapur', 'MZP'], ['Moradabad', 'MBD'], ['Muzaffarnagar', 'MZN'], ['Pilibhit', 'PLB'], ['Pratapgarh', 'PTP'],
  ['Prayagraj', 'PYG'], ['Raebareli', 'RBL'], ['Rampur', 'RMP'], ['Saharanpur', 'SHR'], ['Sambhal', 'SMB'],
  ['Sant Kabir Nagar', 'SKN'], ['Shahjahanpur', 'SJP'], ['Shamli', 'SML'], ['Shravasti', 'SVT'], ['Siddharthnagar', 'SDN'],
  ['Sitapur', 'STP'], ['Sonbhadra', 'SNB'], ['Sultanpur', 'SLT'], ['Unnao', 'UNN'], ['Varanasi', 'VNS']
];

async function run() {
  if (DISTRICTS.length !== 75) throw new Error(`Expected 75 districts, list has ${DISTRICTS.length}`);
  await mongoose.connect(process.env.MONGODB_URI);

  const state = await Location.findOne({ name: STATE_NAME, locationType: 'state' });
  if (!state) throw new Error(`State "${STATE_NAME}" not found — aborting.`);

  let inserted = 0, existing = 0, reconciled = 0;
  for (const [name, code] of DISTRICTS) {
    // Match by name (case-insensitive) as a district — never touch other types/states.
    const found = await Location.findOne({
      name: { $regex: new RegExp(`^${name}$`, 'i') },
      locationType: 'district'
    });

    if (found) {
      // Reconcile parent linkage only if wrong; never rename or change code.
      const needsFix = String(found.parent) !== String(state._id) || found.parentName !== STATE_NAME;
      if (needsFix && (found.parentName == null || found.parentName === STATE_NAME)) {
        found.parent = state._id;
        found.parentName = STATE_NAME;
        found.isActive = true;
        await found.save();
        reconciled++;
      } else {
        existing++;
      }
      continue;
    }

    await Location.create({
      name: name.trim(),
      code: code.trim().toUpperCase(),
      locationType: 'district',
      parent: state._id,
      parentName: STATE_NAME,
      isActive: true
    });
    inserted++;
  }

  const finalCount = await Location.countDocuments({ locationType: 'district', parentName: STATE_NAME, parent: state._id });
  console.log(`Inserted: ${inserted} | Already present: ${existing} | Reconciled: ${reconciled}`);
  console.log(`FINAL Uttar Pradesh district count: ${finalCount}`);
  if (finalCount !== 75) throw new Error(`Count mismatch: expected 75, got ${finalCount}`);
  console.log('✅ Verified: exactly 75 UP districts, correctly linked to Uttar Pradesh.');

  await mongoose.disconnect();
}

run().catch((e) => { console.error('❌', e.message); process.exit(1); });
