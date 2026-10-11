const Admin = require('../models/Admin');
const Location = require('../models/Location');
const DistrictAssignmentRequest = require('../models/DistrictAssignmentRequest');
const AuditLog = require('../models/AuditLog');

const norm = (s) => String(s || '').trim().toLowerCase();
const isAdmin = (req) => !!(req.admin && (req.admin.role === 'admin' || req.admin.role === 'superadmin'));

// A state in-charge = has assigned state(s) or the "State In-Charge" display role.
async function loadIncharge(req) {
  const id = req.admin && (req.admin.id || req.admin._id);
  if (!id) return null;
  const doc = await Admin.findById(id)
    .select('name username displayRole role assignedState assignedStates managedDistricts managedStates permissions.managedDistricts permissions.managedStates')
    .lean();
  if (!doc) return null;
  const states = [...new Set([doc.assignedState, ...(doc.assignedStates || [])].filter(Boolean))];
  const isStateIncharge = doc.displayRole === 'State In-Charge' || states.length > 0;
  // The District Division page saves each in-charge's districts under
  // permissions.managedDistricts — read that FIRST (top-level managedDistricts is a
  // legacy/empty field). Without this, every in-charge fell back to the WHOLE state's
  // districts and could assign into another in-charge's districts (overlap).
  const districts = (doc.permissions && doc.permissions.managedDistricts && doc.permissions.managedDistricts.length)
    ? doc.permissions.managedDistricts
    : (doc.managedDistricts || []);
  return { doc, states, districts, isStateIncharge };
}

// ── STATE IN-CHARGE: propose an assignment (goes to admin as "pending") ──
exports.createRequest = async (req, res) => {
  try {
    const inc = await loadIncharge(req);
    if (!inc || (!inc.isStateIncharge && !isAdmin(req))) {
      return res.status(403).json({ error: 'Only state in-charges can request assignments.' });
    }
    const reporterId = String((req.body && req.body.reporterId) || '');
    const district = String((req.body && req.body.district) || '').trim();
    const tier = (req.body && req.body.tier) === 'stringer' ? 'stringer' : 'district_incharge';
    if (!reporterId || !district) {
      return res.status(400).json({ error: 'reporterId and district are required.' });
    }

    // Resolve the district's state from the Location master (authoritative — never
    // trust a client-sent state). Falls back to the body only if not found.
    const loc = await Location.findOne({ locationType: 'district', name: district }).select('parentName').lean();
    const state = (loc && loc.parentName) || String((req.body && req.body.state) || '').trim();
    if (!state) return res.status(400).json({ error: 'Could not resolve this district\'s state.' });

    // Scope: state in-charge can only act inside their own state, and (if the admin
    // has divided districts among them) only inside their own districts.
    if (!isAdmin(req)) {
      if (inc.states.length && !inc.states.some((s) => norm(s) === norm(state))) {
        return res.status(403).json({ error: 'This district is outside your state.' });
      }
      if (inc.districts.length && !inc.districts.some((d) => norm(d) === norm(district))) {
        return res.status(403).json({ error: 'This district is not in your assigned districts.' });
      }
    }

    const reporter = await Admin.findOne({ _id: reporterId, role: 'editor' }).select('name username').lean();
    if (!reporter) return res.status(404).json({ error: 'Reporter not found.' });

    // Avoid duplicate pending requests for the same reporter+district.
    const existing = await DistrictAssignmentRequest.findOne({ reporterId, district, status: 'pending' }).lean();
    if (existing) return res.status(409).json({ error: 'A pending request already exists for this reporter and district.' });

    // STRICT: one district = one district in-charge — enforced even at the PENDING
    // stage, so a state in-charge can't send two reporters to the same district.
    if (tier === 'district_incharge') {
      const pendingDup = await DistrictAssignmentRequest.findOne({
        district, tier: 'district_incharge', status: 'pending', reporterId: { $ne: reporterId },
      }).select('reporterName').lean();
      if (pendingDup) {
        return res.status(409).json({
          error: `A district in-charge request for "${district}" is already pending (${pendingDup.reporterName}). Approve or reject that first.`,
        });
      }
      const assigned = await Admin.findOne({
        reporterTier: 'district_incharge', assignedDistricts: district, isActive: { $ne: false },
      }).select('name username').lean();
      if (assigned) {
        return res.status(409).json({
          error: `"${district}" already has an in-charge: ${assigned.name || assigned.username}.`,
        });
      }
      // STRICT (other direction): one district in-charge = ONE district. A reporter
      // who already holds a district as in-charge, or has another in-charge
      // proposal pending, cannot be proposed for a second district.
      const held = await Admin.findOne({
        _id: reporterId, reporterTier: 'district_incharge',
        assignedDistricts: { $exists: true, $ne: [] },
      }).select('assignedDistricts').lean();
      if (held) {
        return res.status(409).json({
          error: `${reporter.name || reporter.username} is already district in-charge of "${(held.assignedDistricts || []).join(', ')}". One person can be in-charge of only one district — remove that first.`,
        });
      }
      const otherPending = await DistrictAssignmentRequest.findOne({
        reporterId, tier: 'district_incharge', status: 'pending', district: { $ne: district },
      }).select('district').lean();
      if (otherPending) {
        return res.status(409).json({
          error: `${reporter.name || reporter.username} already has a pending in-charge request for "${otherPending.district}". One person can be in-charge of only one district.`,
        });
      }
    }

    const doc = await DistrictAssignmentRequest.create({
      stateInchargeId: inc.doc._id,
      stateInchargeName: inc.doc.name || inc.doc.username || '',
      reporterId, reporterName: reporter.name || reporter.username || '',
      state, district, tier, status: 'pending',
    });
    return res.json({ ok: true, request: doc });
  } catch (e) {
    console.error('createRequest error:', e);
    return res.status(500).json({ error: 'Could not submit request.' });
  }
};

// ── STATE IN-CHARGE: see the status of their own requests ──
exports.myRequests = async (req, res) => {
  try {
    const inc = await loadIncharge(req);
    if (!inc) return res.status(403).json({ error: 'Forbidden.' });
    const rows = await DistrictAssignmentRequest.find({ stateInchargeId: inc.doc._id })
      .sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ ok: true, requests: rows });
  } catch (e) {
    console.error('myRequests error:', e);
    return res.status(500).json({ error: 'Could not load your requests.' });
  }
};

// ── ADMIN: list pending requests (support page) ──
exports.listPending = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
    const status = ['pending', 'approved', 'rejected', 'revoked'].includes(req.query.status) ? req.query.status : 'pending';
    const rows = await DistrictAssignmentRequest.find({ status })
      .sort({ createdAt: -1 }).limit(300).lean();
    return res.json({ ok: true, status, requests: rows });
  } catch (e) {
    console.error('listPending error:', e);
    return res.status(500).json({ error: 'Could not load requests.' });
  }
};

// ── ADMIN: approve → actually apply the assignment ──
exports.approve = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
    const reqDoc = await DistrictAssignmentRequest.findById(req.params.id);
    if (!reqDoc) return res.status(404).json({ error: 'Request not found.' });
    if (reqDoc.status !== 'pending') return res.status(409).json({ error: 'Already ' + reqDoc.status + '.' });

    // STRICT: one district = one district in-charge.
    if (reqDoc.tier === 'district_incharge') {
      const conflict = await Admin.findOne({
        _id: { $ne: reqDoc.reporterId },
        reporterTier: 'district_incharge',
        assignedDistricts: reqDoc.district,
        isActive: { $ne: false },
      }).select('name username');
      if (conflict) {
        return res.status(409).json({
          error: `"${reqDoc.district}" already has an in-charge: ${conflict.name || conflict.username}. Reject this or remove them first.`,
        });
      }
      // STRICT (other direction): one district in-charge = ONE district.
      const held = await Admin.findOne({
        _id: reqDoc.reporterId, reporterTier: 'district_incharge',
        assignedDistricts: { $exists: true, $ne: [] },
      }).select('name username assignedDistricts').lean();
      const otherHeld = held ? (held.assignedDistricts || []).filter(d => norm(d) !== norm(reqDoc.district)) : [];
      if (otherHeld.length) {
        return res.status(409).json({
          error: `${held.name || held.username || reqDoc.reporterName} is already district in-charge of "${otherHeld.join(', ')}". One person can be in-charge of only one district — remove that assignment first.`,
        });
      }
    }

    // Remember the tier we are replacing so "Remove" can restore it later.
    const beforeReporter = await Admin.findById(reqDoc.reporterId).select('reporterTier').lean();
    await Admin.updateOne(
      { _id: reqDoc.reporterId },
      { $addToSet: { assignedDistricts: reqDoc.district }, $set: { reporterTier: reqDoc.tier } }
    );

    // 'none' = the reporter had no tier (regular reporter); null = not captured (old records).
    reqDoc.previousTier = (beforeReporter && beforeReporter.reporterTier) || 'none';
    reqDoc.status = 'approved';
    reqDoc.reviewedBy = req.admin.id || req.admin._id || null;
    reqDoc.reviewedByName = req.admin.username || req.admin.name || '';
    reqDoc.reviewedAt = new Date();
    await reqDoc.save();

    // The district now has an in-charge — auto-reject any OTHER pending in-charge
    // requests for the same district so the queue stays consistent.
    if (reqDoc.tier === 'district_incharge') {
      await DistrictAssignmentRequest.updateMany(
        { _id: { $ne: reqDoc._id }, district: reqDoc.district, tier: 'district_incharge', status: 'pending' },
        { $set: {
            status: 'rejected',
            rejectReason: 'District already assigned to another in-charge',
            reviewedBy: req.admin.id || req.admin._id || null,
            reviewedByName: req.admin.username || req.admin.name || '',
            reviewedAt: new Date(),
        } }
      );
    }
    return res.json({ ok: true, request: reqDoc });
  } catch (e) {
    console.error('approve error:', e);
    return res.status(500).json({ error: 'Could not approve.' });
  }
};

// ── ADMIN: revoke (remove) an APPROVED assignment ──
// Undoes what approve() applied: pulls the district from the reporter and, when
// the reporter has no other approved district in-charge assignment left, restores
// the tier they had before approval (or 'stringer' for old records without it).
exports.revoke = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
    const reqDoc = await DistrictAssignmentRequest.findById(req.params.id);
    if (!reqDoc) return res.status(404).json({ error: 'Request not found.' });
    if (reqDoc.status !== 'approved') return res.status(409).json({ error: 'Only approved assignments can be removed (this one is ' + reqDoc.status + ').' });

    const reporter = await Admin.findById(reqDoc.reporterId).select('name username reporterTier assignedDistricts').lean();
    const before = reporter ? { reporterTier: reporter.reporterTier || null, assignedDistricts: (reporter.assignedDistricts || []).slice() } : null;
    const update = {};
    let restoredTier = null;
    if (reporter) {
      // Case-insensitive match so a district saved with different casing still gets removed.
      const match = (reporter.assignedDistricts || []).find(d => norm(d) === norm(reqDoc.district));
      if (match) update.$pull = { assignedDistricts: match };

      if (reqDoc.tier === 'district_incharge') {
        const stillIncharge = await DistrictAssignmentRequest.exists({
          _id: { $ne: reqDoc._id }, reporterId: reqDoc.reporterId, tier: 'district_incharge', status: 'approved',
        });
        if (!stillIncharge && reporter.reporterTier === 'district_incharge') {
          // Tier from BEFORE the reporter first became in-charge: a later request's
          // previousTier is 'district_incharge' (captured while already in-charge),
          // so walk back to the earliest capture that is not. 'none' → regular
          // reporter; nothing captured (old records) → 'stringer'.
          let prev = reqDoc.previousTier;
          if (!prev || prev === 'district_incharge') {
            const earliest = await DistrictAssignmentRequest.findOne({
              reporterId: reqDoc.reporterId, tier: 'district_incharge',
              previousTier: { $nin: [null, 'district_incharge'] },
            }).sort({ reviewedAt: 1 }).select('previousTier').lean();
            prev = earliest ? earliest.previousTier : null;
          }
          restoredTier = prev === 'none' ? null : (prev || 'stringer');
          update.$set = { reporterTier: restoredTier };
        }
      }
      if (Object.keys(update).length) await Admin.updateOne({ _id: reqDoc.reporterId }, update);
    }

    reqDoc.status = 'revoked';
    reqDoc.revokeReason = String((req.body && req.body.reason) || '').trim();
    reqDoc.revokedBy = req.admin.id || req.admin._id || null;
    reqDoc.revokedByName = req.admin.username || req.admin.name || '';
    reqDoc.revokedAt = new Date();
    await reqDoc.save();

    const after = reporter ? (await Admin.findById(reqDoc.reporterId).select('reporterTier assignedDistricts').lean()) : null;
    try {
      await AuditLog.create({
        actorId: req.admin.id || req.admin._id || null, actorName: req.admin.username || req.admin.name || '', actorRole: req.admin.role,
        action: 'district_assignment_revoke', entityType: 'DistrictAssignmentRequest', entityId: String(reqDoc._id),
        targetId: String(reqDoc.reporterId), targetName: reqDoc.reporterName || (reporter && (reporter.name || reporter.username)) || '',
        description: `Removed ${reqDoc.tier === 'stringer' ? 'stringer' : 'district in-charge'} assignment "${reqDoc.district}" (${reqDoc.state})` + (reqDoc.revokeReason ? ` — ${reqDoc.revokeReason}` : ''),
        before, after: after ? { reporterTier: after.reporterTier || null, assignedDistricts: after.assignedDistricts || [], restoredTier } : null,
      });
    } catch (logErr) { console.error('revoke audit log failed:', logErr.message); }

    return res.json({ ok: true, request: reqDoc, restoredTier });
  } catch (e) {
    console.error('revoke error:', e);
    return res.status(500).json({ error: 'Could not remove the assignment.' });
  }
};

// ── ADMIN: reject ──
exports.reject = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
    const reqDoc = await DistrictAssignmentRequest.findById(req.params.id);
    if (!reqDoc) return res.status(404).json({ error: 'Request not found.' });
    if (reqDoc.status !== 'pending') return res.status(409).json({ error: 'Already ' + reqDoc.status + '.' });
    reqDoc.status = 'rejected';
    reqDoc.rejectReason = String((req.body && req.body.reason) || '').trim();
    reqDoc.reviewedBy = req.admin.id || req.admin._id || null;
    reqDoc.reviewedByName = req.admin.username || req.admin.name || '';
    reqDoc.reviewedAt = new Date();
    await reqDoc.save();
    return res.json({ ok: true, request: reqDoc });
  } catch (e) {
    console.error('reject error:', e);
    return res.status(500).json({ error: 'Could not reject.' });
  }
};

// ── STATE IN-CHARGE: their scope (districts they can assign into) + reporters ──
exports.myScope = async (req, res) => {
  try {
    const inc = await loadIncharge(req);
    if (!inc || (!inc.isStateIncharge && !isAdmin(req))) {
      return res.status(403).json({ error: 'State in-charges only.' });
    }
    // Districts they can assign into: their division (managedDistricts) if the
    // admin has set one; otherwise every district in their state(s).
    let districts = inc.districts.slice();
    if (!districts.length && inc.states.length) {
      const rows = await Location.find({ locationType: 'district', parentName: { $in: inc.states } })
        .select('name').sort({ name: 1 }).lean();
      districts = rows.map((r) => r.name);
    }
    // Reporters in their state(s).
    const reporters = inc.states.length
      ? await Admin.find({
          role: 'editor', isActive: { $ne: false },
          $or: [{ assignedState: { $in: inc.states } }, { assignedStates: { $in: inc.states } }],
        }).select('name username mobileNumber reporterTier assignedDistricts assignedState').sort({ name: 1 }).lean()
      : [];
    return res.json({ ok: true, states: inc.states, districts, reporters });
  } catch (e) {
    console.error('myScope error:', e);
    return res.status(500).json({ error: 'Could not load your area.' });
  }
};

// ── STATE IN-CHARGE: render their assign page ──
exports.renderMyPage = async (req, res) => {
  try {
    res.render('my-district-assignments', {
      title: 'Assign Reporters',
      activePage: 'my-district-assignments',
      admin: req.admin,
    });
  } catch (e) {
    console.error('renderMyPage error:', e);
    res.status(500).send('Error loading page');
  }
};

// ── ADMIN: DIVISION — split a state's districts among its state in-charges ──
exports.renderDivisionPage = async (req, res) => {
  try {
    res.render('district-division', {
      title: 'District Division',
      activePage: 'district-division',
      admin: req.admin,
    });
  } catch (e) {
    console.error('renderDivisionPage error:', e);
    res.status(500).send('Error loading page');
  }
};

// States that have at least one state in-charge.
exports.divisionStates = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
    const incs = await Admin.find({ role: { $in: ['editor', 'subeditor'] }, isActive: { $ne: false } })
      .select('assignedState assignedStates displayRole').lean();
    const set = new Set();
    incs.forEach((a) => {
      if (a.displayRole === 'State In-Charge' || (a.assignedStates && a.assignedStates.length) || a.assignedState) {
        [a.assignedState, ...(a.assignedStates || [])].filter(Boolean).forEach((s) => set.add(s));
      }
    });
    return res.json({ ok: true, states: [...set].sort() });
  } catch (e) {
    console.error('divisionStates error:', e);
    return res.status(500).json({ error: 'Could not load states.' });
  }
};

// For one state: its districts + its state in-charges (with current managedDistricts).
exports.divisionData = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
    const state = String(req.query.state || '').trim();
    if (!state) return res.status(400).json({ error: 'state is required.' });
    const districts = (await Location.find({ locationType: 'district', parentName: state })
      .select('name').sort({ name: 1 }).lean()).map((r) => r.name);
    // In-charges only — reporters/desk editors must NOT appear here. Prefer the
    // org "State In-Charge" role tag (Phase-D metadata, display-filter only, not
    // authorization); fall back to all sub-editors of the state if roles are
    // absent. The real division lives in permissions.managedDistricts (top-level
    // managedDistricts is not in the Admin schema, so the old read/write was
    // silently broken).
    const baseQuery = {
      role: 'subeditor', isActive: { $ne: false },
      $or: [{ assignedState: state }, { assignedStates: state }],
    };
    let query = baseQuery;
    try {
      const sicRole = await require('../models/Role').findOne({ name: 'State In-Charge' }).select('_id').lean();
      if (sicRole) {
        const n = await Admin.countDocuments({ ...baseQuery, roleIds: sicRole._id });
        if (n > 0) query = { ...baseQuery, roleIds: sicRole._id };
      }
    } catch (_) { /* Role model/collection unavailable → sub-editor fallback */ }
    const incharges = (await Admin.find(query)
      .select('name username displayRole permissions.managedDistricts').sort({ name: 1 }).lean())
      .map((a) => ({
        _id: a._id,
        name: a.name,
        username: a.username,
        displayRole: a.displayRole,
        managedDistricts: (a.permissions && a.permissions.managedDistricts) || [],
      }));
    return res.json({ ok: true, state, districts, incharges });
  } catch (e) {
    console.error('divisionData error:', e);
    return res.status(500).json({ error: 'Could not load division.' });
  }
};

// Save one in-charge's managed districts.
exports.saveDivision = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
    const inchargeId = String((req.body && req.body.inchargeId) || '');
    const districts = Array.isArray(req.body && req.body.districts)
      ? [...new Set(req.body.districts.map((d) => String(d).trim()).filter(Boolean))] : [];
    if (!inchargeId) return res.status(400).json({ error: 'inchargeId is required.' });
    // Write to the REAL field (schema path). The old top-level $set was silently
    // stripped by strict mode — "Saved ✓" without saving anything.
    await Admin.updateOne({ _id: inchargeId }, { $set: { 'permissions.managedDistricts': districts } });
    return res.json({ ok: true, managedDistricts: districts });
  } catch (e) {
    console.error('saveDivision error:', e);
    return res.status(500).json({ error: 'Could not save.' });
  }
};

// ── ADMIN: render the support page ──
exports.renderApprovalsPage = async (req, res) => {
  try {
    const pendingCount = await DistrictAssignmentRequest.countDocuments({ status: 'pending' });
    res.render('district-assignment-approvals', {
      title: 'District Assignment Approvals',
      activePage: 'district-assignment-approvals',
      admin: req.admin,
      pendingCount,
    });
  } catch (e) {
    console.error('renderApprovalsPage error:', e);
    res.status(500).send('Error loading approvals page');
  }
};
