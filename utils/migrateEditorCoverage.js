/**
 * Migrate editor/sub-editor coverage fields from legacy single-state + flat lists.
 * Safe to run multiple times.
 *
 * Usage: node utils/migrateEditorCoverage.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const { computeAssignedLocations, uniqueStrings } = require('./editorCoverageHelper');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB');

  const editors = await Admin.find({ role: { $in: ['editor', 'subeditor'] } });
  let updated = 0;

  for (const editor of editors) {
    let changed = false;

    const states = uniqueStrings([
      ...(editor.assignedStates || []),
      ...(editor.assignedState ? [editor.assignedState] : [])
    ]);
    if (states.length && JSON.stringify(editor.assignedStates || []) !== JSON.stringify(states)) {
      editor.assignedStates = states;
      if (!editor.assignedState && states[0]) editor.assignedState = states[0];
      changed = true;
    }

    const constituencies = uniqueStrings([
      ...(editor.assignedConstituencies || []),
      ...(editor.constituency ? [editor.constituency] : [])
    ]);
    if (constituencies.length && JSON.stringify(editor.assignedConstituencies || []) !== JSON.stringify(constituencies)) {
      editor.assignedConstituencies = constituencies;
      changed = true;
    }

    const computedLocations = computeAssignedLocations({
      states: editor.assignedStates || states,
      districts: editor.assignedDistricts || [],
      constituencies: editor.assignedConstituencies || constituencies,
      legacyLocations: editor.assignedLocations || []
    });
    if (computedLocations.length && JSON.stringify(editor.assignedLocations || []) !== JSON.stringify(computedLocations)) {
      editor.assignedLocations = computedLocations;
      changed = true;
    }

    if (editor.role === 'subeditor' && editor.permissions) {
      const perms = editor.permissions;
      const managedFlat = perms.managedLocations || [];
      if (managedFlat.length && !(perms.managedDistricts || []).length && !(perms.managedStates || []).length) {
        // Keep flat list; geography matching uses managedLocations
        perms.managedLocations = uniqueStrings(managedFlat);
        changed = true;
      }
      if (perms.approvalScope === 'locations') {
        // stays as locations for backward compat; helper treats as geography
      }
    }

    if (changed) {
      await editor.save();
      updated += 1;
      console.log(`  ✓ ${editor.username} (${editor.role})`);
    }
  }

  console.log(`\n✅ Migration complete — ${updated} editor(s) updated`);
  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
