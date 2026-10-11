/**
 * Staff Profile Overview (Editors list → row chevron / "Profile Overview").
 * READ-ONLY. Everything is computed from the live Admin / News / AuditLog /
 * DistrictAssignmentRequest data on each request — nothing is stored or
 * hard-coded. Admin / superadmin only (routes use requireAdmin).
 *
 *   GET /admin/api/staff/:id/overview        → JSON for the side panel
 *   GET /admin/api/staff/:id/team.(csv|xlsx) → reporters under this in-charge
 *   GET /admin/api/staff/hierarchy.(csv|xlsx)→ State → In-charge → District → Reporter
 */
const mongoose = require('mongoose');
const XLSX = require('xlsx');
const Admin = require('../models/Admin');
const News = require('../models/News');
const Location = require('../models/Location');
const AuditLog = require('../models/AuditLog');
const DistrictAssignmentRequest = require('../models/DistrictAssignmentRequest');
const H = require('../utils/editorCoverageHelper');

const STAFF_SELECT = 'name username email mobileNumber role displayRole reporterTier workingLanguage isActive createdAt lastLogin profileImage assignedState assignedStates assignedDistricts assignedConstituencies assignedLocations location constituency permissions';
const LANG = { te: 'Telugu', en: 'English', hi: 'Hindi', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi', pa: 'Punjabi', gu: 'Gujarati', bn: 'Bengali', or: 'Odia', ur: 'Urdu' };
const norm = (v) => String(v || '').trim().toLowerCase();
const isAdmin = (req) => !!(req.admin && (req.admin.role === 'admin' || req.admin.role === 'superadmin'));
const active = (s) => s.isActive !== false;
const nameOf = (s) => (s && (s.name || s.username) || '').trim();
const langLabel = (c) => (c ? (LANG[c] || c) : '');

async function loadStaff() {
  return Admin.find({ role: { $in: ['editor', 'subeditor'] } }).select(STAFF_SELECT).lean();
}

/** district name (lower) → state name, from the Location master. */
async function loadDistrictStateMap() {
  const rows = await Location.find({ locationType: 'district' }).select('name parentName').lean();
  const map = {};
  rows.forEach(r => { if (r.name) map[norm(r.name)] = r.parentName || ''; });
  return map;
}

/** Published / today / 7-day counts per author for a set of ids (same boundaries as the editors list). */
async function newsStatsFor(ids) {
  const out = {};
  if (!ids.length) return out;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7); weekAgo.setHours(0, 0, 0, 0);
  const rows = await News.aggregate([
    { $match: { authorId: { $in: ids }, isActive: true } },
    { $group: {
      _id: '$authorId',
      published: { $sum: 1 },
      today: { $sum: { $cond: [{ $gte: ['$publishedAt', today] }, 1, 0] } },
      weekly: { $sum: { $cond: [{ $gte: ['$publishedAt', weekAgo] }, 1, 0] } },
    } },
  ]);
  rows.forEach(r => { out[String(r._id)] = { published: r.published, today: r.today, weekly: r.weekly }; });
  return out;
}

/** Sub-editors whose explicit team or approval geography covers this reporter. */
function coveringSubEditors(reporter, subs) {
  const rid = String(reporter._id);
  return subs.filter(s => {
    const ids = H.uniqueStrings(s.permissions && s.permissions.managedReporterIds || []);
    return ids.includes(rid) || H.reporterMatchesCoverage(reporter, H.getSubEditorManagedCoverage(s));
  });
}

/** Reporters under an in-charge (sub-editor: explicit ∪ geography; district in-charge: same district). */
function teamOf(person, staff) {
  const kind = H.staffKind(person);
  const reporters = staff.filter(s => s.role === 'editor' && String(s._id) !== String(person._id));
  if (kind === 'subeditor') {
    const perms = person.permissions || {};
    const scope = H.normalizeApprovalScope(perms.approvalScope);
    const explicit = new Set(H.uniqueStrings(perms.managedReporterIds || []));
    const cov = H.getSubEditorManagedCoverage(person);
    const hasGeo = !!(cov.states.length || cov.districts.length || cov.constituencies.length || cov.locations.length);
    if (scope === 'all') return { members: reporters, basis: 'all' };
    if (scope === 'reporters') return { members: reporters.filter(r => explicit.has(String(r._id))), basis: 'reporters' };
    const members = reporters.filter(r => explicit.has(String(r._id)) || (hasGeo && H.reporterMatchesCoverage(r, cov)));
    return { members, basis: scope };
  }
  if (kind === 'district_incharge') {
    const mine = H.getReporterCoverage(person).districts.map(norm);
    if (!mine.length) return { members: [], basis: 'district' };
    return { members: reporters.filter(r => H.getReporterCoverage(r).districts.some(d => mine.includes(norm(d)))), basis: 'district' };
  }
  return { members: [], basis: 'none' };
}

function memberRow(r, stats, subs, districtState) {
  const cov = H.getReporterCoverage(r);
  const st = stats[String(r._id)] || { published: 0, today: 0, weekly: 0 };
  const covering = coveringSubEditors(r, subs);
  return {
    id: String(r._id),
    name: nameOf(r),
    role: H.staffRoleLabel(r),
    kind: H.staffKind(r),
    mobile: r.mobileNumber || '',
    email: r.email || '',
    state: cov.states[0] || (cov.districts[0] ? districtState[norm(cov.districts[0])] || '' : ''),
    states: cov.states,
    districts: cov.districts,
    language: langLabel(r.workingLanguage),
    isActive: r.isActive !== false,
    createdAt: r.createdAt || null,
    published: st.published, today: st.today, weekly: st.weekly,
    inCharges: covering.map(nameOf),
    flags: {
      noDistrict: !cov.districts.length,
      noState: !cov.states.length,
      multiInCharge: covering.length > 1,
      inactive: r.isActive === false,
    },
  };
}

async function buildOverview(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const [staff, districtState] = await Promise.all([loadStaff(), loadDistrictStateMap()]);
  const person = staff.find(s => String(s._id) === String(id));
  if (!person) return null;

  const kind = H.staffKind(person);
  const subs = staff.filter(s => s.role === 'subeditor' && active(s));
  const dics = staff.filter(s => s.role === 'editor' && s.reporterTier === 'district_incharge' && active(s));
  const selfId = String(person._id);

  // ---- assignment (from the person's own record) ----
  let states = [], districts = [], constituencies = [], scope = null, explicitIds = [];
  if (kind === 'subeditor') {
    const c = H.getSubEditorManagedCoverage(person);
    states = c.states; districts = c.districts; constituencies = c.constituencies;
    scope = H.normalizeApprovalScope(person.permissions && person.permissions.approvalScope);
    explicitIds = H.uniqueStrings(person.permissions && person.permissions.managedReporterIds || []);
  } else {
    const c = H.getReporterCoverage(person);
    states = c.states; districts = c.districts; constituencies = c.constituencies;
  }
  const stateOf = (d) => districtState[norm(d)] || (states.length === 1 ? states[0] : '');
  // District-only geography (e.g. a Bureau managing 31 UP districts, no state list):
  // derive the state(s) from the districts so the panel never says "Not Assigned".
  const derivedStates = states.length ? [] : H.uniqueStrings(districts.map(d => districtState[norm(d)]).filter(Boolean));

  // Duplicate detection: same STATE + DISTRICT held by another person of the same kind.
  const duplicatesFor = (d) => {
    const st = stateOf(d);
    const holders = kind === 'subeditor'
      ? subs.filter(o => String(o._id) !== selfId && H.getSubEditorManagedCoverage(o).districts.some(x => norm(x) === norm(d) && (districtState[norm(x)] || st) === st))
      : (kind === 'district_incharge'
        ? dics.filter(o => String(o._id) !== selfId && (o.assignedDistricts || []).some(x => norm(x) === norm(d) && (districtState[norm(x)] || st) === st))
        : []);
    return holders.map(h => ({ id: String(h._id), name: nameOf(h), role: H.staffRoleLabel(h) }));
  };
  const districtsByState = {};
  districts.forEach(d => {
    const st = stateOf(d) || 'Unknown state';
    (districtsByState[st] = districtsByState[st] || []).push({ name: d, duplicates: duplicatesFor(d) });
  });
  const duplicateDistricts = Object.values(districtsByState).flat().filter(d => d.duplicates.length);
  // One warning per other holder (not per district): { id, name, role, districts[] }
  const groupDuplicates = (list) => {
    const byPerson = {};
    list.forEach(d => d.duplicates.forEach(o => { (byPerson[o.id] = byPerson[o.id] || { id: o.id, name: o.name, role: o.role, districts: [] }).districts.push(d.name); }));
    return Object.values(byPerson);
  };
  // Whole-state overlap for sub-editors (two state-level people managing the same state).
  const stateOverlaps = kind === 'subeditor'
    ? states.map(st => ({ state: st, others: subs.filter(o => String(o._id) !== selfId && H.getSubEditorManagedCoverage(o).states.map(norm).includes(norm(st))).map(o => ({ id: String(o._id), name: nameOf(o), role: H.subEditorRoleLabel(o) })) })).filter(x => x.others.length)
    : [];

  // ---- who is above (responsibility) and who is below (team) ----
  const responsibility = H.resolveResponsibilityFor(person, staff);
  if (kind === 'subeditor' && !responsibility.self.length && derivedStates.length) responsibility.selfDerived = derivedStates;
  const team = teamOf(person, staff);
  const teamIds = team.members.map(m => String(m._id));
  const stats = await newsStatsFor([selfId, ...teamIds]);
  const members = team.members.map(m => memberRow(m, stats, subs, districtState)).sort((a, b) => a.name.localeCompare(b.name));
  const me = stats[selfId] || { published: 0, today: 0, weekly: 0 };

  // ---- warnings / conflicts ----
  const warnings = [];
  const push = (level, code, text, detail) => warnings.push({ level, code, text, detail: detail || null });
  if (kind === 'subeditor') {
    if (!states.length && !districts.length && !constituencies.length && !explicitIds.length && scope !== 'all') push('warn', 'no_geography', 'No approval geography or team assigned — this sub-editor routes nothing.');
    if (!members.length) push('warn', 'no_reporters', 'No reporters are currently under this in-charge.');
    groupDuplicates(duplicateDistricts).forEach(g => push('danger', 'duplicate_district', `${g.districts.length} district(s) also assigned to ${g.name} (${g.role}): ${g.districts.join(', ')}.`, g));
    stateOverlaps.forEach(s => push('info', 'state_overlap', `State "${s.state}" is also managed by ${s.others.map(o => `${o.name} (${o.role})`).join(', ')}.`, s));
  } else {
    if (!states.length) push('warn', 'no_state', 'No state assigned.');
    if (!districts.length) push('warn', 'no_district', 'No district assigned.');
    if (kind === 'district_incharge' && districts.length > 1) push('danger', 'multi_district_incharge', `District In-Charge holds ${districts.length} districts — the rule is one district per in-charge.`);
    groupDuplicates(duplicateDistricts).forEach(g => push('danger', 'duplicate_district', `District(s) also held by ${g.name} (District In-Charge): ${g.districts.join(', ')}.`, g));
    const above = coveringSubEditors(person, subs);
    if (!above.length) push('warn', 'no_incharge', 'No active sub-editor / Bureau / State In-Charge covers this person.');
    if (above.length > 1) push('info', 'multi_incharge', `Covered by ${above.length} sub-editors: ${above.map(nameOf).join(', ')}.`, above.map(a => ({ id: String(a._id), name: nameOf(a), role: H.subEditorRoleLabel(a) })));
    if (kind === 'district_incharge' && !members.length) push('warn', 'no_reporters', 'No reporters are currently under this District In-Charge.');
  }
  if (person.isActive === false) push('warn', 'inactive_self', 'This account is locked / inactive.');
  const teamUnassigned = members.filter(m => m.flags.noDistrict);
  const teamInactive = members.filter(m => !m.isActive);
  const teamMulti = members.filter(m => m.flags.multiInCharge);
  if (teamUnassigned.length) push('warn', 'team_unassigned', `${teamUnassigned.length} reporter(s) under this in-charge have no district assigned.`, teamUnassigned.map(m => m.name));
  if (teamInactive.length) push('info', 'team_inactive', `${teamInactive.length} reporter(s) under this in-charge are inactive.`, teamInactive.map(m => m.name));
  if (teamMulti.length) push('info', 'team_multi_incharge', `${teamMulti.length} reporter(s) are covered by more than one sub-editor.`, teamMulti.map(m => `${m.name} → ${m.inCharges.join(', ')}`));

  // ---- assignment history (audit log + district assignment requests) ----
  const [audits, requests] = await Promise.all([
    AuditLog.find({ $or: [{ targetId: person._id }, { entityId: selfId }], action: { $regex: /district|assign|tier|editor_update|coverage/i } })
      .sort({ createdAt: -1 }).limit(30).select('action actorName actorRole description before after createdAt').lean(),
    DistrictAssignmentRequest.find({ $or: [{ reporterId: person._id }, { stateInchargeId: person._id }] })
      .sort({ updatedAt: -1 }).limit(30).lean(),
  ]);
  const history = [];
  audits.forEach(a => history.push({ at: a.createdAt, source: 'audit', action: a.action, by: a.actorName || '', text: a.description || a.action, before: a.before, after: a.after }));
  requests.forEach(r => {
    const who = r.reporterName || '';
    const base = `${r.tier === 'stringer' ? 'Stringer' : 'District In-Charge'} request: ${who} → ${r.district} (${r.state})`;
    history.push({ at: r.createdAt, source: 'request', action: 'district_request_created', by: r.stateInchargeName || '', text: `${base} proposed` });
    if (r.reviewedAt) history.push({ at: r.reviewedAt, source: 'request', action: 'district_request_' + (r.status === 'revoked' ? 'approved' : r.status), by: r.reviewedByName || '', text: `${base} ${r.status === 'revoked' ? 'approved' : r.status}${r.rejectReason ? ' — ' + r.rejectReason : ''}` });
    if (r.revokedAt) history.push({ at: r.revokedAt, source: 'request', action: 'district_request_revoked', by: r.revokedByName || '', text: `${base} removed${r.revokeReason ? ' — ' + r.revokeReason : ''}` });
  });
  history.sort((a, b) => new Date(b.at) - new Date(a.at));
  const lastAssignmentUpdate = history.length ? history[0].at : null;

  return {
    person: {
      id: selfId, name: nameOf(person), username: person.username || '', email: person.email || '', mobile: person.mobileNumber || '',
      role: H.staffRoleLabel(person), kind, baseRole: person.role, displayRole: person.displayRole || '', reporterTier: person.reporterTier || null,
      language: langLabel(person.workingLanguage), languageCode: person.workingLanguage || '',
      isActive: person.isActive !== false, createdAt: person.createdAt || null, lastLogin: person.lastLogin || null,
      profileImage: person.profileImage || '',
    },
    stats: me,
    assignment: {
      states, derivedStates, districts, constituencies, districtsByState, scope, explicitTeamCount: explicitIds.length,
      legacyLocations: (person.assignedLocations || []), legacyLocation: person.location || '',
      notAssigned: !states.length && !districts.length && !constituencies.length && !explicitIds.length && scope !== 'all',
      stateOverlaps,
    },
    responsibility,
    team: { basis: team.basis, count: members.length, active: members.filter(m => m.isActive).length, inactive: teamInactive.length, unassigned: teamUnassigned.length, multiInCharge: teamMulti.length, members },
    overview: {
      assignedStates: states.length || derivedStates.length, assignedDistricts: districts.length, totalReporters: members.length,
      activeReporters: members.filter(m => m.isActive).length, inactiveReporters: teamInactive.length,
      duplicateDistricts: duplicateDistricts.length, unassignedReporters: teamUnassigned.length, conflicts: warnings.filter(w => w.level === 'danger').length,
    },
    warnings,
    history: history.slice(0, 40),
    lastAssignmentUpdate,
    generatedAt: new Date(),
  };
}

exports.overview = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
    const data = await buildOverview(req.params.id);
    if (!data) return res.status(404).json({ error: 'Staff member not found.' });
    return res.json({ ok: true, ...data });
  } catch (e) {
    console.error('staff overview error:', e);
    return res.status(500).json({ error: 'Could not build the profile overview.' });
  }
};

// ---------------------------------------------------------------- exports
const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: '2-digit' }) : '';
const safeFile = (s) => String(s || 'staff').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'staff';

function sendSheet(res, rows, headers, sheetName, filename, format) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  if (format === 'csv') {
    const csv = '﻿' + XLSX.utils.sheet_to_csv(ws);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(csv);
  }
  const wb = XLSX.utils.book_new();
  ws['!cols'] = headers.map(h => ({ wch: Math.max(12, Math.min(40, h.length + 6)) }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
  return res.send(buf);
}

exports.teamExport = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
    const format = req.params.format === 'csv' ? 'csv' : 'xlsx';
    const data = await buildOverview(req.params.id);
    if (!data) return res.status(404).json({ error: 'Staff member not found.' });
    const headers = ['Name', 'Role', 'Email', 'Mobile', 'State', 'District', 'Language', 'Status', 'Created Date', 'Published News', 'Today', '7 Days', 'In-Charge(s)', 'Flags'];
    const rows = data.team.members.map(m => ({
      'Name': m.name, 'Role': m.role, 'Email': m.email, 'Mobile': m.mobile,
      'State': m.states.join(', ') || m.state, 'District': m.districts.join(', '), 'Language': m.language,
      'Status': m.isActive ? 'Active' : 'Inactive', 'Created Date': fmtDate(m.createdAt),
      'Published News': m.published, 'Today': m.today, '7 Days': m.weekly,
      'In-Charge(s)': m.inCharges.join(', '),
      'Flags': [m.flags.noDistrict ? 'No district' : '', m.flags.multiInCharge ? 'Multiple in-charges' : ''].filter(Boolean).join('; '),
    }));
    // Context rows on top: who this list belongs to.
    const p = data.person;
    rows.unshift({ 'Name': `Reporters under: ${p.name} (${p.role})`, 'Role': `States: ${data.assignment.states.join(', ') || '—'}`, 'Email': `Districts: ${data.assignment.districts.join(', ') || '—'}`, 'Mobile': `Generated: ${fmtDate(new Date())}` }, {});
    return sendSheet(res, rows, headers, 'Reporters', `reporters_under_${safeFile(p.name)}`, format);
  } catch (e) {
    console.error('team export error:', e);
    return res.status(500).json({ error: 'Could not export the reporter list.' });
  }
};

exports.hierarchyExport = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only.' });
    const format = req.params.format === 'csv' ? 'csv' : 'xlsx';
    const [staff, districtState] = await Promise.all([loadStaff(), loadDistrictStateMap()]);
    const subs = staff.filter(s => s.role === 'subeditor' && active(s));
    const reporters = staff.filter(s => s.role === 'editor');
    const stats = await newsStatsFor(reporters.map(r => String(r._id)));
    const rows = reporters.map(r => {
      const m = memberRow(r, stats, subs, districtState);
      const resp = H.resolveResponsibilityFor(r, staff);
      return {
        'State': m.states.join(', ') || m.state, 'State Level In-Charge': resp.state.map(s => `${s.name} (${s.role})`).join(', '),
        'District': m.districts.join(', '), 'District In-Charge': m.kind === 'district_incharge' ? 'Self' : resp.district.map(d => d.name).join(', '),
        'Reporter': m.name, 'Role': m.role, 'Mobile': m.mobile, 'Email': m.email, 'Language': m.language,
        'Status': m.isActive ? 'Active' : 'Inactive', 'Created Date': fmtDate(m.createdAt), 'Published News': m.published,
        'Flags': [m.flags.noState ? 'No state' : '', m.flags.noDistrict ? 'No district' : '', m.flags.multiInCharge ? 'Multiple in-charges' : '', !resp.state.length ? 'No in-charge' : ''].filter(Boolean).join('; '),
      };
    }).sort((a, b) => (a['State'] || '').localeCompare(b['State']) || (a['District'] || '').localeCompare(b['District']) || a['Reporter'].localeCompare(b['Reporter']));
    const headers = ['State', 'State Level In-Charge', 'District', 'District In-Charge', 'Reporter', 'Role', 'Mobile', 'Email', 'Language', 'Status', 'Created Date', 'Published News', 'Flags'];
    return sendSheet(res, rows, headers, 'Hierarchy', `reporter_hierarchy_${new Date().toISOString().slice(0, 10)}`, format);
  } catch (e) {
    console.error('hierarchy export error:', e);
    return res.status(500).json({ error: 'Could not export the hierarchy.' });
  }
};

exports._buildOverview = buildOverview; // for scripts/tests
