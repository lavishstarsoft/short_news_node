'use strict';

/**
 * reporterDistrictController — Admin/Super-Admin tool to manually assign a canonical
 * district to a reporter (role 'editor'). Phase-1 focus: Uttar Pradesh.
 *
 * SECURITY (all server-side):
 *  - every handler re-checks admin/superadmin (never trust the client),
 *  - the selected district MUST exist in the canonical Location collection; the
 *    stored value is Location.name (never the client string), the Location _id is
 *    recorded in the audit trail only (routing key stays the name),
 *  - idempotent $addToSet, no case-duplicates,
 *  - every assign/remove writes an append-only AuditLog (before/after + locationId
 *    + assignmentId + actor).
 *
 * Routing/approval scope is computed live from reporter.assignedDistricts
 * (see editorCoverageHelper.getManagedReporterIds), so an assignment takes effect
 * immediately with no denormalised cache and no state-level catch-all.
 */

const crypto = require('crypto');
const Admin = require('../models/Admin');
const Location = require('../models/Location');
const ReporterApplication = require('../models/ReporterApplication');
const AuditLog = require('../models/AuditLog');

const norm = (s) => String(s || '').trim().toLowerCase();
const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
// Harmless-format key + state-marker stripping, to test whether a free-text value
// names a canonical district of the selected state (used ONLY to surface reporters
// for review — never to auto-assign).
const _STOP = new Set(['up', 'u', 'p', 'uttar', 'pradesh', 'uttarpradesh', 'district', 'distt', 'dist', 'the']);
const districtKey = (v) => {
  if (!v) return '';
  const s = String(v).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/u\.p\.?/g, ' ').replace(/[^a-z\s]/g, ' ');
  return s.split(/\s+/).filter(t => t && !_STOP.has(t)).join(' ').trim();
};
const isAdmin = (req) => !!(req.admin && (req.admin.role === 'admin' || req.admin.role === 'superadmin'));
const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Resolve a client-supplied district to its canonical Location doc (exact, case-insensitive). */
async function resolveCanonicalDistrict(name, state) {
  const q = { locationType: 'district', name: { $regex: `^${escapeRx(String(name || '').trim())}$`, $options: 'i' } };
  if (state) q.parentName = { $regex: `^${escapeRx(state)}$`, $options: 'i' };
  return Location.findOne(q).select('name parentName _id').lean();
}

// Build an email/phone index of applications once per request.
async function buildAppIndex() {
  const apps = await ReporterApplication.find({}).select('data createdAt').lean();
  const byEmail = new Map(), byPhone = new Map();
  for (const a of apps) {
    const e = norm(a.data && a.data.email);
    const p = last10(a.data && (a.data.phone_number || a.data['Alternate Mobile']));
    if (e && (!byEmail.has(e) || new Date(a.createdAt) > new Date(byEmail.get(e).createdAt))) byEmail.set(e, a);
    if (p && (!byPhone.has(p) || new Date(a.createdAt) > new Date(byPhone.get(p).createdAt))) byPhone.set(p, a);
  }
  return { byEmail, byPhone };
}
const appOf = (idx, r) => idx.byEmail.get(norm(r.email)) || idx.byPhone.get(last10(r.mobileNumber)) || null;
const appGeo = (a) => a ? { state: a.data.State || '', district: a.data.District || '', constituency: a.data.constituency || a.data.constancy || '', location: a.data.Location || '' } : { state: '', district: '', constituency: '', location: '' };

// GET page.
exports.renderPage = (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Access denied. Admins only.');
  res.render('reporter-district-assignment', { admin: req.admin, activePage: 'reporter-district-assignment' });
};

// GET canonical districts for a state (dropdown source).
exports.districts = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
  const state = String(req.query.state || 'Uttar Pradesh').trim();
  const rows = await Location.find({ locationType: 'district', parentName: { $regex: `^${escapeRx(state)}$`, $options: 'i' } })
    .select('name _id').sort({ name: 1 }).lean();
  res.json({ state, districts: rows.map(r => ({ id: r._id, name: r.name })) });
};

// GET reporters list (with evidence summary + status) for a state.
exports.listReporters = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
  const state = String(req.query.state || 'Uttar Pradesh').trim();
  const status = String(req.query.status || 'all');
  const q = norm(req.query.q || '');

  const stateDistrictDocs = await Location.find({ locationType: 'district', parentName: { $regex: `^${escapeRx(state)}$`, $options: 'i' } }).select('name').lean();
  const stateDistricts = new Set(stateDistrictDocs.map(r => norm(r.name)));
  const stateDistrictKeys = new Set(stateDistrictDocs.map(r => districtKey(r.name)));
  const namesFreeTextInState = (...vals) => vals.some(v => { const k = districtKey(v); return k && stateDistrictKeys.has(k); });
  const idx = await buildAppIndex();
  const reporters = await Admin.find({ role: 'editor', isActive: { $ne: false } })
    .select('name email mobileNumber assignedDistricts assignedStates assignedState assignedLocations location constituency').lean();

  const out = [];
  for (const r of reporters) {
    const app = appOf(idx, r);
    const g = appGeo(app);
    const assignedInState = (r.assignedDistricts || []).filter(d => stateDistricts.has(norm(d)));
    const stateMatch = [g.state, r.assignedState, r.location, ...(r.assignedStates || [])].some(v => v && norm(v) === norm(state));
    // Also relevant if their application/constituency/location free-text names a
    // canonical district of this state (surfaces conflict cases like a mismatched
    // home-state but a UP constituency — for review only, never auto-assign).
    const freeTextInState = namesFreeTextInState(g.district, g.location, r.constituency, g.constituency);
    // Only reporters relevant to the selected state.
    if (!assignedInState.length && !stateMatch && !freeTextInState) continue;

    const st = assignedInState.length ? 'assigned' : 'manual_review'; // unassigned-but-in-state = needs manual review
    if (status !== 'all' && status !== st && !(status === 'unassigned' && st === 'manual_review')) continue;
    if (q && ![r.name, r.email, r.mobileNumber].some(v => norm(v).includes(q))) continue;

    out.push({
      id: r._id, name: r.name || '', email: r.email || '', phone: r.mobileNumber || '',
      state: r.assignedState || (r.assignedStates || [])[0] || g.state || '',
      currentDistricts: r.assignedDistricts || [],
      constituency: r.constituency || g.constituency || '',
      applicationDistrict: g.district || '', applicationState: g.state || '',
      status: st
    });
  }
  out.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'manual_review' ? -1 : 1));
  res.json({ state, count: out.length, reporters: out });
};

// GET full evidence for one reporter.
exports.evidence = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
  const r = await Admin.findOne({ _id: req.params.id, role: 'editor' })
    .select('name email mobileNumber assignedDistricts assignedStates assignedState assignedLocations location constituency').lean();
  if (!r) return res.status(404).json({ error: 'Reporter not found.' });
  const idx = await buildAppIndex();
  const app = appOf(idx, r);
  const g = appGeo(app);
  res.json({
    reporter: {
      name: r.name, email: r.email, phone: r.mobileNumber,
      assignedDistricts: r.assignedDistricts || [], assignedStates: r.assignedStates || [], assignedState: r.assignedState || null,
      location: r.location || '', constituency: r.constituency || '', assignedLocations: r.assignedLocations || []
    },
    application: app ? { state: g.state, district: g.district, constituency: g.constituency, location: g.location, matchedBy: idx.byEmail.get(norm(r.email)) ? 'email' : 'phone' } : null
  });
};

// POST assign a canonical district to a reporter.
exports.assign = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
  const reporterId = String((req.body && req.body.reporterId) || '');
  const districtInput = String((req.body && req.body.district) || '').trim();
  const state = String((req.body && req.body.state) || '').trim() || null;
  if (!reporterId || !districtInput) return res.status(400).json({ error: 'reporterId and district are required.' });

  const canon = await resolveCanonicalDistrict(districtInput, state);
  if (!canon) return res.status(400).json({ error: 'District is not a valid canonical Location district.' });

  const reporter = await Admin.findOne({ _id: reporterId, role: 'editor' });
  if (!reporter) return res.status(404).json({ error: 'Reporter not found (must be role editor).' });

  const before = (reporter.assignedDistricts || []).slice();
  const already = before.some(d => norm(d) === norm(canon.name));
  if (already) return res.json({ ok: true, changed: false, message: 'Already assigned (no change).', assignedDistricts: before });

  await Admin.updateOne({ _id: reporterId, assignedDistricts: { $ne: canon.name } }, { $addToSet: { assignedDistricts: canon.name } });
  const after = (await Admin.findById(reporterId).select('assignedDistricts').lean()).assignedDistricts || [];

  const assignmentId = 'RDA-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  await AuditLog.create({
    actorId: req.admin.id || req.admin._id || null, actorName: req.admin.username || req.admin.name || '', actorRole: req.admin.role,
    action: 'reporter_district_assign', entityType: 'Admin', entityId: reporterId,
    targetId: reporterId, targetName: reporter.name || '',
    description: `Assigned canonical district "${canon.name}" (LocationID ${canon._id}) [${assignmentId}]`,
    before: { assignedDistricts: before },
    after: { assignedDistricts: after, canonicalDistrict: canon.name, locationId: String(canon._id), state: canon.parentName, assignmentId }
  });

  res.json({ ok: true, changed: true, district: canon.name, locationId: String(canon._id), assignmentId, assignedDistricts: after });
};

// POST remove a district from a reporter.
exports.remove = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
  const reporterId = String((req.body && req.body.reporterId) || '');
  const districtInput = String((req.body && req.body.district) || '').trim();
  if (!reporterId || !districtInput) return res.status(400).json({ error: 'reporterId and district are required.' });

  const reporter = await Admin.findOne({ _id: reporterId, role: 'editor' });
  if (!reporter) return res.status(404).json({ error: 'Reporter not found.' });
  const before = (reporter.assignedDistricts || []).slice();
  const match = before.find(d => norm(d) === norm(districtInput));
  if (!match) return res.json({ ok: true, changed: false, message: 'District not present (no change).', assignedDistricts: before });

  await Admin.updateOne({ _id: reporterId }, { $pull: { assignedDistricts: match } });
  const after = (await Admin.findById(reporterId).select('assignedDistricts').lean()).assignedDistricts || [];

  const assignmentId = 'RDA-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  await AuditLog.create({
    actorId: req.admin.id || req.admin._id || null, actorName: req.admin.username || req.admin.name || '', actorRole: req.admin.role,
    action: 'reporter_district_remove', entityType: 'Admin', entityId: reporterId,
    targetId: reporterId, targetName: reporter.name || '',
    description: `Removed district "${match}" [${assignmentId}]`,
    before: { assignedDistricts: before }, after: { assignedDistricts: after, removed: match, assignmentId }
  });

  res.json({ ok: true, changed: true, removed: match, assignedDistricts: after });
};
