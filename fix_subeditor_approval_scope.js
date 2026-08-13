'use strict';
/**
 * One-time fix: align the APPROVAL geography of specific sub-editors to the
 * districts/states they were actually allocated (assigned* fields), using the
 * shared syncApprovalScopeToAssigned() rule. After this, Approval Mode shows only
 * reporters inside each sub-editor's allocated area.
 *
 * Idempotent (re-running yields the same result). Only touches the listed members.
 *
 *   node fix_subeditor_approval_scope.js          # apply + verify
 *   node fix_subeditor_approval_scope.js --dry     # verify current state only
 */

require('dotenv').config({ path: __dirname + '/.env' });
const mongoose = require('mongoose');
const { syncApprovalScopeToAssigned, getManagedReporterIds, getSubEditorManagedCoverage } = require('./utils/editorCoverageHelper');

const DRY = process.argv.includes('--dry');
const EMAILS = ['ashwani.awasthi786@gmail.com', 'asrafansarietw62@gmail.com', 'praveenbhargav26@gmail.com'];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Admin = require('./models/Admin');
  const Location = require('./models/Location');

  for (const email of EMAILS) {
    const doc = await Admin.findOne({ email: email.toLowerCase(), role: 'subeditor' });
    if (!doc) { console.log(`\n• ${email} → NOT FOUND`); continue; }
    const p0 = doc.permissions || {};
    console.log(`\n=== ${doc.name} <${email}> ===`);
    console.log(`  BEFORE: managedDistricts=${(p0.managedDistricts||[]).length}  managedStates=${JSON.stringify(p0.managedStates||[])}  managedLocations=${(p0.managedLocations||[]).length}`);

    if (!DRY) {
      await syncApprovalScopeToAssigned(Location, doc);
      await doc.save();
    }

    const fresh = await Admin.findOne({ email: email.toLowerCase() });
    const p = fresh.permissions || {};
    console.log(`  AFTER : managedDistricts=${(p.managedDistricts||[]).length}  managedStates=${JSON.stringify(p.managedStates||[])}  managedLocations=${(p.managedLocations||[]).length}`);

    // Verify: which reporters now fall in scope, and are they all inside the allocated area?
    const ids = await getManagedReporterIds(Admin, fresh);
    const reporters = await Admin.find({ _id: { $in: ids } })
      .select('name assignedDistricts assignedStates assignedState location').lean();
    const cov = getSubEditorManagedCoverage(fresh);
    const allowedDistricts = new Set(cov.districts);
    const allowedStates = new Set(cov.states);
    const outside = reporters.filter(r => {
      const rd = (r.assignedDistricts || []);
      const rs = [...(r.assignedStates || []), ...(r.assignedState ? [r.assignedState] : [])];
      const inDistrict = rd.some(d => allowedDistricts.has(d));
      const inState = rs.some(s => allowedStates.has(s));
      const inLoc = r.location && (allowedDistricts.has(r.location) || allowedStates.has(r.location));
      return !(inDistrict || inState || inLoc);
    });
    console.log(`  reporters in approval scope: ${reporters.length}`);
    console.log(`  scope districts=${cov.districts.length}  states=${JSON.stringify(cov.states)}`);
    console.log(`  reporters OUTSIDE allocated area: ${outside.length} ${outside.length ? '❌ ' + JSON.stringify(outside.slice(0,5).map(r=>r.name)) : '✅'}`);
  }

  console.log(`\n${DRY ? '(dry run — no changes written)' : '✅ Fix applied.'}`);
  await mongoose.connection.close();
  process.exit(0);
})().catch(async (e) => { console.error('ERROR:', e.message); try { await mongoose.connection.close(); } catch (_) {} process.exit(1); });
