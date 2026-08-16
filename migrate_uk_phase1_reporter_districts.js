'use strict';
/**
 * UK PHASE-1 MIGRATION — for the 4 audited, email-verified Uttarakhand reporters:
 *   - set State → Uttarakhand (assignedState/assignedStates/location; UP→UK for the 3
 *     mis-stated; Anees already Uttarakhand),
 *   - assign the canonical Uttarakhand district NAME (routing key) via $set on
 *     assignedDistricts (case-insensitive de-dupe, canonical form kept).
 *
 * Touches ONLY these 4 (matched by EMAIL). Preserves every other field and every
 * other reporter/in-charge. Stores canonical Location NAME; records Location _id +
 * migrationId in AuditLog (append-only). Idempotent: re-running makes no change.
 *
 *   node migrate_uk_phase1_reporter_districts.js           # dry-run (default, no writes)
 *   node migrate_uk_phase1_reporter_districts.js --apply   # perform writes
 */
require('dotenv').config({ path: __dirname + '/.env' });
const crypto = require('crypto');
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = 'UKMIG-' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 15) + '-' + crypto.randomBytes(3).toString('hex');
const STATE = 'Uttarakhand';
const norm = (s) => String(s || '').trim().toLowerCase();
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// email → canonical district. State is forced to Uttarakhand for all four.
const TARGETS = [
  { email: 'diveshsagar007@gmail.com', name: 'Divesh Sagar', district: 'Haridwar' },
  { email: 'razaanees0786@gmail.com',  name: 'Anees Raza',   district: 'Udham Singh Nagar' },
  { email: 'gulshabaturki@gmail.com',  name: 'Gulsabha',     district: 'Udham Singh Nagar' },
  { email: 'a2zdhanraj@gmail.com',     name: 'Dhanraj Garg', district: 'Dehradun' },
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Admin = require('./models/Admin');
  const Location = require('./models/Location');
  const AuditLog = require('./models/AuditLog');

  console.log(`UK Phase-1 reporter migration [${MIGRATION_ID}] — ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  // Resolve canonical Location district docs under Uttarakhand (must exist — run seed first).
  const canon = new Map();
  for (const t of TARGETS) {
    const doc = await Location.findOne({
      locationType: 'district', parentName: STATE,
      name: { $regex: new RegExp(`^${escapeRx(t.district)}$`, 'i') }
    }).select('name _id parentName').lean();
    if (!doc) { console.error(`❌ Canonical district "${t.district}" not found under ${STATE}. Run seed-uttarakhand-districts.js first.`); await mongoose.disconnect(); process.exit(1); }
    canon.set(t.email, doc);
  }

  let changed = 0, unchanged = 0;
  for (const t of TARGETS) {
    const r = await Admin.findOne({ email: t.email.toLowerCase(), role: 'editor' })
      .select('name email mobileNumber assignedState assignedStates assignedDistricts location').lean();
    if (!r) { console.error(`❌ Reporter (editor) not found: ${t.email}`); continue; }
    const dist = canon.get(t.email);

    const before = {
      assignedState: r.assignedState || null,
      assignedStates: (r.assignedStates || []).slice(),
      assignedDistricts: (r.assignedDistricts || []).slice(),
      location: r.location || null,
    };

    // Desired assignedDistricts: existing + canonical, de-duped case-insensitively (keep canonical form).
    const seen = new Set(); const finalDistricts = [];
    for (const d of [...(r.assignedDistricts || []), dist.name]) {
      const k = norm(d);
      if (!seen.has(k)) { seen.add(k); finalDistricts.push(k === norm(dist.name) ? dist.name : d); }
    }
    const after = {
      assignedState: STATE,
      assignedStates: [STATE],
      assignedDistricts: finalDistricts,
      location: dist.name,
    };

    const same = before.assignedState === after.assignedState
      && JSON.stringify(before.assignedStates) === JSON.stringify(after.assignedStates)
      && JSON.stringify(before.assignedDistricts.map(norm).sort()) === JSON.stringify(after.assignedDistricts.map(norm).sort())
      && before.location === after.location;

    console.log(`${t.name} <${t.email} / ${r.mobileNumber || '-'}>  (LocationID ${dist._id})`);
    console.log('  before:', JSON.stringify(before));
    console.log('  after :', JSON.stringify(after));

    if (same) { unchanged++; console.log('  = no change (idempotent)\n'); continue; }

    if (APPLY) {
      await Admin.updateOne({ _id: r._id }, { $set: {
        assignedState: after.assignedState,
        assignedStates: after.assignedStates,
        assignedDistricts: after.assignedDistricts,
        location: after.location,
      }});
      await AuditLog.create({
        actorId: null, actorName: 'UK-PHASE1-MIGRATION', actorRole: 'system',
        action: 'uk_phase1_reporter_migrate', entityType: 'Admin', entityId: String(r._id),
        targetId: r._id, targetName: r.name || t.name,
        description: `UK Phase-1: state→${STATE}, canonical district "${dist.name}" (LocationID ${dist._id}) [${MIGRATION_ID}]`,
        before,
        after: { ...after, canonicalDistrict: dist.name, locationId: String(dist._id), migrationId: MIGRATION_ID },
      });
      changed++; console.log('  ✔ applied + audit-logged\n');
    } else {
      changed++; console.log('  ~ would change (dry-run)\n');
    }
  }

  console.log(`${APPLY ? 'Applied' : 'Would change'}: ${changed} | Unchanged: ${unchanged} | migrationId=${MIGRATION_ID}`);
  await mongoose.disconnect();
})().catch((e) => { console.error('❌', e.message); try { mongoose.disconnect(); } catch (_) {} process.exit(1); });
