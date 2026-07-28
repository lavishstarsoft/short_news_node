/**
 * READ-ONLY diagnostic for the Add News State/District dropdown issue.
 * Makes NO database writes and changes NO application code.
 * Deletable after use.
 *
 * Usage (from the Node/ folder, same env as the server):
 *   node diagnose-subeditor-locations.js                 # scan ALL sub editors
 *   node diagnose-subeditor-locations.js <username|email> # one sub editor
 *
 * It prints, from live data:
 *   1. assignedStates / assignedDistricts / allowedScopes for each sub editor
 *   3. which assignedDistricts are NOT present as ACTIVE districts in the hierarchy
 *   4. the exact allowedStates array rebuildStateOptions() would produce, and
 *      whether that yields ZERO options (empty dropdown)
 *   5. active-hierarchy counts, so if the hierarchy itself is empty you know the
 *      cause is data/connection, not the filter.
 * For item 2 (raw endpoint JSON) use the curl command in the chat message.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('./models/Admin');
const Location = require('./models/Location');

const TARGET = process.argv[2] || null;

(async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/short_news';
  await mongoose.connect(uri);
  console.log('Connected to:', uri.replace(/\/\/[^@]*@/, '//<redacted>@'));

  // Exactly what /api/public/location-hierarchy serves (active only).
  const hierarchy = await Location.getHierarchy();
  const activeDistrictNames = new Set();
  hierarchy.forEach((s) => (s.districts || []).forEach((d) => activeDistrictNames.add(d.name)));

  console.log('\n=== ACTIVE HIERARCHY (what the browser receives) ===');
  console.log('active states   :', hierarchy.length);
  console.log('active districts:', activeDistrictNames.size);
  if (hierarchy.length === 0 || activeDistrictNames.size === 0) {
    console.log('!! Hierarchy is empty -> root cause is DATA/CONNECTION, not the sub-editor filter.');
  }

  const q = { role: 'subeditor' };
  if (TARGET) q.$or = [{ username: TARGET }, { email: String(TARGET).toLowerCase() }];

  const subs = await Admin.find(q)
    .select('username email role assignedStates assignedDistricts allowedScopes permissions.managedDistricts workingLanguage')
    .lean();

  console.log(`\nInspecting ${subs.length} sub editor(s)${TARGET ? ` matching "${TARGET}"` : ''}:`);

  const affected = [];
  for (const s of subs) {
    const assignedStates = s.assignedStates || [];
    const assignedDistricts = s.assignedDistricts || [];
    const allowedScopes = s.allowedScopes || [];

    // Item 3: mismatches
    const mismatches = assignedDistricts.filter((d) => !activeDistrictNames.has(d));

    // Item 4: replicate rebuildStateOptions() district-scope branch exactly
    const allowedStatesDistrictScope = hierarchy
      .filter((st) => (st.districts || []).some((d) => assignedDistricts.includes(d.name)))
      .map((st) => st.name);

    const emptyInDistrictScope =
      assignedDistricts.length > 0 && allowedStatesDistrictScope.length === 0;

    console.log('\n────────────────────────────────────────');
    console.log('user             :', s.username, '|', s.email);
    console.log('allowedScopes    :', JSON.stringify(allowedScopes));
    console.log('assignedStates   :', JSON.stringify(assignedStates));
    console.log('assignedDistricts:', JSON.stringify(assignedDistricts));
    console.log('permissions.managedDistricts (approval scope, NOT used by Add News):',
      JSON.stringify(s.permissions?.managedDistricts || []));
    console.log('assignedDistricts NOT active in hierarchy (mismatch):', JSON.stringify(mismatches));
    console.log('rebuildStateOptions() district-scope result           :', JSON.stringify(allowedStatesDistrictScope));
    console.log('=> district-scope State dropdown zero options?         :',
      emptyInDistrictScope ? 'YES  <-- reproduces the bug' : 'no');

    if (emptyInDistrictScope) affected.push(s.username || s.email);
  }

  console.log('\n=== RESULT ===');
  if (affected.length) {
    console.log('Sub editors whose District-scope State dropdown is empty from live data:');
    console.log('  ' + affected.join('\n  '));
    console.log('Root cause is PROVEN for these accounts (empty assignedDistricts∩activeHierarchy).');
  } else {
    console.log('No sub editor reproduces the empty district-scope dropdown from live data.');
    console.log('=> The cause is NOT the coverage filter. Re-check: allowedScopes/default scope,');
    console.log('   the raw endpoint JSON (curl), and the browser console on the actual page.');
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
