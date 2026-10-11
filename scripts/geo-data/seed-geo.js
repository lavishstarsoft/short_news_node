/**
 * Seed India-wide geography (state → district → mandal → village) into the
 * `geolocations` collection. ADDITIVE — never touches the business `Location`.
 *
 * Usage:
 *   node scripts/geo-data/seed-geo.js                 # states + districts + mandals only
 *   node scripts/geo-data/seed-geo.js --villages      # + villages (needs data/4-village.csv, see download-villages.sh)
 *   node scripts/geo-data/seed-geo.js --villages --states=28,36   # only Andhra Pradesh (28) + Telangana (36) villages
 *   node scripts/geo-data/seed-geo.js --villages --include-uninhabited
 *
 * Idempotent: re-running upserts (no duplicates). Safe to stop and resume.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mongoose = require('mongoose');
const GeoLocation = require('../../models/GeoLocation');

const DATA = path.join(__dirname, 'data');
const VILLAGE_CSV = path.join(DATA, '4-village.csv');

const args = process.argv.slice(2);
const doVillages = args.includes('--villages');
const includeUninhabited = args.includes('--include-uninhabited');
const stateFilterArg = args.find((a) => a.startsWith('--states='));
const stateFilter = stateFilterArg ? new Set(stateFilterArg.split('=')[1].split(',').map((s) => s.trim())) : null;

const norm = (s) => (s || '').trim();
const searchKey = (s) => norm(s).toLowerCase();

/** Minimal RFC-4180-ish CSV line splitter (handles quoted fields with commas). */
function splitCsv(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function upsertMany(rows) {
  if (!rows.length) return;
  const ops = rows.map((r) => ({
    updateOne: { filter: { type: r.type, code: r.code }, update: { $set: r }, upsert: true },
  }));
  await GeoLocation.bulkWrite(ops, { ordered: false });
}

async function seedJson(file, mapFn) {
  const list = JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf-8'));
  const rows = list.map(mapFn);
  for (let i = 0; i < rows.length; i += 5000) await upsertMany(rows.slice(i, i + 5000));
  return rows.length;
}

async function seedVillages() {
  if (!fs.existsSync(VILLAGE_CSV)) {
    console.log(`\n⚠️  ${VILLAGE_CSV} not found. Run scripts/geo-data/download-villages.sh first (or drop the CSV there). Skipping villages.`);
    return 0;
  }
  // Header (0-indexed): 0 S.No, 1 District Code, 2 District Name, 3 Subdistrict Code,
  // 4 Subdistrict Name, 5 Village Code, 6 Village Version, 7 Village Name (Eng),
  // 8 Village Name (Local), 9 Village Status, 10 Census2001, 11 Census2011, 12 State Code, 13 State Name.
  const rl = readline.createInterface({ input: fs.createReadStream(VILLAGE_CSV), crlfDelay: Infinity });
  let header = true;
  let batch = [];
  let seeded = 0;
  let skipped = 0;
  for await (const line of rl) {
    if (header) { header = false; continue; }
    if (!line.trim()) continue;
    const c = splitCsv(line);
    const stateCode = norm(c[12]);
    if (stateFilter && !stateFilter.has(stateCode)) continue;
    const status = norm(c[9]);
    if (!includeUninhabited && /uninhab/i.test(status)) { skipped++; continue; }
    const name = norm(c[7]);
    const code = norm(c[5]);
    if (!name || !code) continue;
    batch.push({
      type: 'village',
      name,
      code,
      search: searchKey(name),
      stateCode,
      stateName: norm(c[13]),
      districtCode: norm(c[1]),
      districtName: norm(c[2]),
      mandalCode: norm(c[3]),
      mandalName: norm(c[4]),
      status,
    });
    if (batch.length >= 5000) {
      await upsertMany(batch);
      seeded += batch.length;
      batch = [];
      if (seeded % 50000 === 0) console.log(`  …villages seeded: ${seeded.toLocaleString()}`);
    }
  }
  await upsertMany(batch);
  seeded += batch.length;
  console.log(`  villages seeded: ${seeded.toLocaleString()} (skipped ${skipped.toLocaleString()} uninhabited)`);
  return seeded;
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/shortnews';
  console.log('🔌 connecting…', uri.replace(/\/\/[^@]*@/, '//***@'));
  await mongoose.connect(uri);
  await GeoLocation.init(); // ensure indexes

  console.log('🏛️  states…');
  const s = await seedJson('states.json', (r) => ({
    type: 'state', name: r.name, code: r.code, search: searchKey(r.name),
    stateCode: r.code, stateName: r.name,
  }));
  console.log(`   ${s} states`);

  console.log('🗺️  districts…');
  const d = await seedJson('districts.json', (r) => ({
    type: 'district', name: r.name, code: r.code, search: searchKey(r.name),
    stateCode: r.stateCode, stateName: r.stateName, districtCode: r.code, districtName: r.name,
  }));
  console.log(`   ${d} districts`);

  console.log('📍 mandals…');
  const m = await seedJson('mandals.json', (r) => ({
    type: 'mandal', name: r.name, code: r.code, search: searchKey(r.name),
    stateCode: r.stateCode, stateName: r.stateName, districtCode: r.districtCode, districtName: r.districtName,
    mandalCode: r.code, mandalName: r.name,
  }));
  console.log(`   ${m} mandals`);

  if (doVillages) {
    console.log(`🏘️  villages${stateFilter ? ' (states ' + [...stateFilter].join(',') + ')' : ' (all India)'}…`);
    await seedVillages();
  } else {
    console.log('🏘️  villages skipped (pass --villages to include; see README).');
  }

  const total = await GeoLocation.estimatedDocumentCount();
  console.log(`\n✅ done. geolocations total ≈ ${total.toLocaleString()}`);
  await mongoose.disconnect();
}

main().catch(async (e) => { console.error('❌', e); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
