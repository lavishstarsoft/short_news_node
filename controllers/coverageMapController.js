'use strict';

/**
 * Coverage Intelligence Map (P1/P2 + Coverage Audit) — read-only, coverage-scoped.
 *
 * Data rules (verified against live DB):
 *  - State/Bureau In-Charge = sub-editor coverage; a sub-editor only ever sees SELF.
 *  - District In-Charge = reporterTier==='district_incharge' (else "Not Assigned").
 *  - Reporter→District uses assignedDistricts ONLY; exact constituency from
 *    assignedConstituencies ONLY. Never the free-text reporter.constituency.
 *  - Group states by administrativeState.
 *
 * Performance: the Location hierarchy + sub-editor coverage are cached in-memory
 * (stable, read-only). Each level does its grouping in-memory over the permitted
 * reporter set with ONE bounded News aggregate. No raw news reaches the browser.
 * No wallet/reward/routing writes.
 */

const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const News = require('../models/News');
const Location = require('../models/Location');
const {
  getSubEditorManagedCoverage,
  getManagedReporterIds,
  getAdminId,
  uniqueStrings,
} = require('../utils/editorCoverageHelper');
const { istDayRange } = require('../utils/indianDateTime');

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isSuper = (req) => !!(req.admin && (req.admin.role === 'superadmin' || req.admin.role === 'admin'));
const isSub = (req) => !!(req.admin && req.admin.role === 'subeditor');
const meId = (req) => (req.admin && (req.admin.id || req.admin._id)) || null;

const REPORTER_SEL = 'name username mobileNumber role reporterTier isActive assignedStates assignedState assignedDistricts assignedConstituencies location';
const TTL = 5 * 60 * 1000; // hierarchy/sub-editor cache lifetime

const tierLabel = (r) => (r.reporterTier === 'district_incharge' ? 'District In-Charge' : (r.reporterTier === 'stringer' ? 'Stringer' : 'Reporter'));
const statusOf = (r) => (r.isActive === false ? 'Locked' : 'Active');

function istBoundaryObjIds(now = Date.now()) {
  const day = 86400000;
  const oid = (d) => mongoose.Types.ObjectId.createFromTime(Math.floor(d.getTime() / 1000));
  return {
    today: oid(istDayRange(new Date(now)).startUTC),
    week: oid(istDayRange(new Date(now - 6 * day)).startUTC),
    month: oid(istDayRange(new Date(now - 29 * day)).startUTC),
  };
}

// ── Cached Location hierarchy (states, district→state, per-district constituencies) ──
let _geo = null, _geoAt = 0;
async function loadGeo() {
  if (_geo && Date.now() - _geoAt < TTL) return _geo;
  const [states, districts, cons] = await Promise.all([
    Location.find({ locationType: 'state' }).select('name').lean(),
    Location.find({ locationType: 'district' }).select('name parentName administrativeState').lean(),
    Location.find({ locationType: 'constituency' }).select('name parentName administrativeState').lean(),
  ]);
  const stateNames = states.map((s) => s.name);
  const stateSet = new Set(stateNames.map(norm));
  const distToState = new Map();
  const stateDistricts = new Map();
  const stateConsCount = new Map();
  const districtCons = new Map();       // norm(district) -> [constituency names]
  districts.forEach((d) => {
    const st = d.administrativeState || d.parentName;
    distToState.set(norm(d.name), st);
    if (!stateDistricts.has(st)) stateDistricts.set(st, new Set());
    stateDistricts.get(st).add(d.name);
  });
  cons.forEach((c) => {
    const st = c.administrativeState || distToState.get(norm(c.parentName)) || null;
    if (st) stateConsCount.set(st, (stateConsCount.get(st) || 0) + 1);
    const dk = norm(c.parentName);
    if (!districtCons.has(dk)) districtCons.set(dk, []);
    districtCons.get(dk).push(c.name);
  });
  _geo = { stateNames, stateSet, distToState, stateDistricts, stateConsCount, districtCons };
  _geoAt = Date.now();
  return _geo;
}

// ── Cached sub-editor→state coverage map (State/Bureau In-Charges) ──
let _subs = null, _subsAt = 0;
async function subEditorsByState() {
  if (_subs && Date.now() - _subsAt < TTL) return _subs;
  const geo = await loadGeo();
  const subs = await Admin.find({ role: 'subeditor', isActive: { $ne: false } })
    .select('name mobileNumber displayRole permissions assignedStates assignedState').lean();
  const byState = new Map();
  subs.forEach((s) => {
    const cov = getSubEditorManagedCoverage(s);
    const states = new Set();
    cov.states.forEach((x) => states.add(x));
    cov.districts.forEach((d) => { const st = geo.distToState.get(norm(d)); if (st) states.add(st); });
    (s.assignedStates || []).forEach((x) => states.add(x));
    if (s.assignedState) states.add(s.assignedState);
    states.forEach((st) => { if (!byState.has(st)) byState.set(st, []); byState.get(st).push(s); });
  });
  _subs = byState;
  _subsAt = Date.now();
  return _subs;
}

/** Sub-editor sees only self; Super Admin sees all covering In-Charges. */
function visibleInCharges(req, list) {
  if (isSuper(req)) return list || [];
  const self = String(meId(req));
  return (list || []).filter((s) => String(s._id) === self);
}

function reporterStateList(r, geo) {
  const s = [];
  if (r.assignedState) s.push(r.assignedState);
  (r.assignedStates || []).forEach((x) => s.push(x));
  (r.assignedDistricts || []).forEach((d) => { const st = geo.distToState.get(norm(d)); if (st) s.push(st); });
  if (r.location) { const st = geo.distToState.get(norm(r.location)); if (st) s.push(st); else if (geo.stateSet.has(norm(r.location))) s.push(r.location); }
  return uniqueStrings(s).filter((x) => geo.stateSet.has(norm(x)));
}

// ── Permitted reporters (IDOR-safe). Super list cached briefly (read-only). ──
let _superReps = null, _superRepsAt = 0;
async function permittedReporters(req) {
  if (isSuper(req)) {
    if (_superReps && Date.now() - _superRepsAt < TTL) return _superReps;
    _superReps = await Admin.find({ role: 'editor' }).select(REPORTER_SEL).lean();
    _superRepsAt = Date.now();
    return _superReps;
  }
  if (!isSub(req)) return [];
  const sub = await Admin.findById(meId(req)).select('role permissions assignedStates assignedState assignedDistricts');
  if (!sub) return [];
  const ids = await getManagedReporterIds(Admin, sub);
  if (ids === null) return Admin.find({ role: 'editor' }).select(REPORTER_SEL).lean();
  if (!ids.length) return [];
  return Admin.find({ role: 'editor', _id: { $in: ids } }).select(REPORTER_SEL).lean();
}

async function permittedStates(req, geo, reporters) {
  if (isSuper(req)) return null;
  const set = new Set();
  const sub = await Admin.findById(meId(req)).select('role permissions assignedStates assignedState').lean();
  if (sub) {
    const cov = getSubEditorManagedCoverage(sub);
    cov.states.forEach((x) => set.add(x));
    cov.districts.forEach((d) => { const st = geo.distToState.get(norm(d)); if (st) set.add(st); });
    (sub.assignedStates || []).forEach((x) => set.add(x));
    if (sub.assignedState) set.add(sub.assignedState);
  }
  reporters.forEach((r) => reporterStateList(r, geo).forEach((st) => set.add(st)));
  return set;
}

async function newsCounts(ids, b) {
  if (!ids.length) return new Map();
  const rows = await News.aggregate([
    { $match: { authorId: { $in: ids }, _id: { $gte: b.month }, 'rejectionStatus.isRejected': { $ne: true } } },
    { $group: { _id: '$authorId',
      today: { $sum: { $cond: [{ $gte: ['$_id', b.today] }, 1, 0] } },
      week: { $sum: { $cond: [{ $gte: ['$_id', b.week] }, 1, 0] } },
      month: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

async function newsTotals(ids) {
  if (!ids.length) return new Map();
  const rows = await News.aggregate([
    { $match: { authorId: { $in: ids }, 'rejectionStatus.isRejected': { $ne: true } } },
    { $group: { _id: '$authorId', total: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.total]));
}

// ══════════════════════════ ROUTES ══════════════════════════

exports.renderPage = (req, res) => {
  if (!isSuper(req) && !isSub(req)) return res.status(403).send('Access denied.');
  res.render('coverage-map', { admin: req.admin, activePage: 'coverage-map' });
};

// Per-user scope cache (60s) — India overview is stable and reloaded on revisit.
const _scopeCache = new Map();
exports.scope = async (req, res) => {
  try {
    if (!isSuper(req) && !isSub(req)) return res.status(403).json({ error: 'Access denied.' });
    const ck = (req.admin.role) + ':' + String(meId(req));
    const hit = _scopeCache.get(ck);
    if (hit && Date.now() - hit.at < 60000) return res.json(hit.data);
    const geo = await loadGeo();
    const [reporters, subByState] = await Promise.all([permittedReporters(req), subEditorsByState()]);
    const allowed = await permittedStates(req, geo, reporters);
    const b = istBoundaryObjIds();
    const counts = await newsCounts(reporters.map((r) => String(r._id)), b);

    const perState = {};
    const ensure = (st) => (perState[st] = perState[st] || { state: st, reporters: 0, today: 0, week: 0, month: 0, locked: 0, atLimit: 0, inCharges: 0, districts: (geo.stateDistricts.get(st) || new Set()).size, constituencies: geo.stateConsCount.get(st) || 0 });
    reporters.forEach((r) => {
      const st = reporterStateList(r, geo)[0];
      if (!st || (allowed && !allowed.has(st))) return;
      const bk = ensure(st); bk.reporters++;
      if (r.isActive === false) bk.locked++;
      const c = counts.get(String(r._id)); if (c) { bk.today += c.today; bk.week += c.week; bk.month += c.month; }
    });
    for (const [st, list] of subByState) {
      if (allowed && !allowed.has(st)) continue;
      ensure(st).inCharges = new Set(visibleInCharges(req, list).map((s) => String(s._id))).size;
    }

    const statesOut = geo.stateNames.filter((s) => !allowed || allowed.has(s)).map((s) => ({
      name: s,
      assigned: !!(perState[s] && (perState[s].reporters || perState[s].inCharges)),
      kpis: perState[s] || { reporters: 0, inCharges: visibleInCharges(req, subByState.get(s)).length, districts: (geo.stateDistricts.get(s) || new Set()).size, constituencies: geo.stateConsCount.get(s) || 0, today: 0, week: 0, month: 0, locked: 0, atLimit: 0 },
    })).sort((a, b2) => a.name.localeCompare(b2.name));

    const india = statesOut.reduce((acc, s) => {
      ['reporters', 'inCharges', 'districts', 'constituencies', 'today', 'week', 'month', 'locked', 'atLimit'].forEach((k) => { acc[k] += s.kpis[k] || 0; });
      return acc;
    }, { reporters: 0, inCharges: 0, districts: 0, constituencies: 0, today: 0, week: 0, month: 0, locked: 0, atLimit: 0 });

    const payload = { isSuperAdmin: isSuper(req), india, states: statesOut };
    _scopeCache.set(ck, { at: Date.now(), data: payload });
    res.json(payload);
  } catch (e) { console.error('coverage scope error:', e.message); res.status(500).json({ error: 'Failed to load scope.' }); }
};

// GET /coverage-map/api/state/:state → KPIs + enriched district cards
exports.state = async (req, res) => {
  try {
    if (!isSuper(req) && !isSub(req)) return res.status(403).json({ error: 'Access denied.' });
    const geo = await loadGeo();
    const [reporters, subByState] = await Promise.all([permittedReporters(req), subEditorsByState()]);
    const allowed = await permittedStates(req, geo, reporters);
    const state = String(req.params.state || '');
    if (!geo.stateSet.has(norm(state))) return res.status(404).json({ error: 'Unknown state.' });
    if (allowed && !allowed.has(state)) return res.status(403).json({ error: 'Not in your coverage.' });

    const inState = reporters.filter((r) => reporterStateList(r, geo).some((s) => norm(s) === norm(state)));
    const b = istBoundaryObjIds();
    const counts = await newsCounts(inState.map((r) => String(r._id)), b);
    const inCharges = visibleInCharges(req, subByState.get(state));
    const icDesign = inCharges.map((s) => ({ name: s.name, mobile: s.mobileNumber || '', designation: s.displayRole || 'Sub-Editor' }));

    // district cards enriched in ONE in-memory pass (no per-district queries)
    const distNames = [...(geo.stateDistricts.get(state) || new Set())];
    const perDist = new Map(distNames.map((d) => [d, { name: d, reporters: 0, constituencies: (geo.districtCons.get(norm(d)) || []).length, today: 0, week: 0, locked: 0, atLimit: 0, districtInCharge: null }]));
    inState.forEach((r) => {
      const c = counts.get(String(r._id)) || { today: 0, week: 0 };
      (r.assignedDistricts || []).forEach((d) => {
        const e = perDist.get(d); if (!e) return;
        e.reporters++; e.today += c.today; e.week += c.week;
        if (r.isActive === false) e.locked++;
        if (r.reporterTier === 'district_incharge') e.districtInCharge = (e.districtInCharge || []).concat({ name: r.name || '', mobile: r.mobileNumber || '' });
      });
    });

    const kpis = inState.reduce((a, r) => {
      a.reporters++; if (r.isActive === false) a.locked++;
      const c = counts.get(String(r._id)); if (c) { a.today += c.today; a.week += c.week; a.month += c.month; }
      return a;
    }, { reporters: 0, inCharges: new Set(inCharges.map((s) => String(s._id))).size, districts: distNames.length, constituencies: geo.stateConsCount.get(state) || 0, today: 0, week: 0, month: 0, locked: 0, atLimit: 0 });

    res.json({ state, kpis, inCharges: icDesign, districts: [...perDist.values()].sort((a, b2) => a.name.localeCompare(b2.name)) });
  } catch (e) { console.error('coverage state error:', e.message); res.status(500).json({ error: 'Failed to load state.' }); }
};

// GET /coverage-map/api/district/:state/:district → full Coverage Audit (one request)
exports.district = async (req, res) => {
  try {
    if (!isSuper(req) && !isSub(req)) return res.status(403).json({ error: 'Access denied.' });
    const geo = await loadGeo();
    const [reporters, subByState] = await Promise.all([permittedReporters(req), subEditorsByState()]);
    const allowed = await permittedStates(req, geo, reporters);
    const state = String(req.params.state || '');
    const district = String(req.params.district || '');
    if (allowed && !allowed.has(state)) return res.status(403).json({ error: 'Not in your coverage.' });

    const dk = norm(district);
    const inDist = reporters.filter((r) => (r.assignedDistricts || []).some((d) => norm(d) === dk));
    const ids = inDist.map((r) => String(r._id));
    const b = istBoundaryObjIds();
    const [counts, totals] = await Promise.all([newsCounts(ids, b), newsTotals(ids)]);

    const inCharges = visibleInCharges(req, subByState.get(state)).map((s) => ({ name: s.name, mobile: s.mobileNumber || '', designation: s.displayRole || 'Sub-Editor' }));
    const dicReporters = inDist.filter((r) => r.reporterTier === 'district_incharge');
    const districtInCharge = dicReporters.length ? dicReporters.map((r) => ({ name: r.name || '', mobile: r.mobileNumber || '' })) : null;

    // constituency matrix — EVERY constituency in the district (incl. zero-assignment)
    const consList = geo.districtCons.get(dk) || [];
    const consMap = new Map(consList.map((n) => [norm(n), { name: n, reporterNames: [], reporterCount: 0, today: 0, week: 0 }]));
    const reportersNoConstituency = [];

    const reporterRows = inDist.map((r) => {
      const c = counts.get(String(r._id)) || { today: 0, week: 0, month: 0 };
      const myCons = (r.assignedConstituencies || []).filter((x) => consMap.has(norm(x)));
      if (myCons.length) {
        myCons.forEach((cn) => { const e = consMap.get(norm(cn)); e.reporterNames.push(r.name || r.username || ''); e.reporterCount++; e.today += c.today; e.week += c.week; });
      } else {
        reportersNoConstituency.push(r.name || r.username || '');
      }
      return { name: r.name || r.username || '', mobile: r.mobileNumber || '', tier: tierLabel(r), state, district, constituency: myCons[0] || null, today: c.today, week: c.week, total: totals.get(String(r._id)) || 0, status: statusOf(r) };
    });

    const dicName = districtInCharge ? districtInCharge[0].name : null;
    const constituencies = [...consMap.values()].map((e) => ({
      name: e.name, reporterCount: e.reporterCount, reporterNames: e.reporterNames,
      districtInCharge: dicName, today: e.today, week: e.week,
      status: e.reporterCount > 0 ? 'Assigned' : 'Assignment Missing',
    })).sort((a, b2) => a.name.localeCompare(b2.name));

    const kpis = {
      reporters: inDist.length, constituencies: consList.length,
      locked: inDist.filter((r) => r.isActive === false).length, atLimit: 0,
      today: reporterRows.reduce((s, r) => s + r.today, 0),
      week: reporterRows.reduce((s, r) => s + r.week, 0),
      month: inDist.reduce((s, r) => s + ((counts.get(String(r._id)) || {}).month || 0), 0),
    };

    const gaps = {
      zeroReporterConstituencies: constituencies.filter((c) => c.reporterCount === 0).map((c) => c.name),
      reportersNoConstituency,
      noDistrictInCharge: !districtInCharge,
    };

    res.json({ state, district, kpis, inCharges, districtInCharge, constituencies, reporters: reporterRows, gaps });
  } catch (e) { console.error('coverage district error:', e.message); res.status(500).json({ error: 'Failed to load district.' }); }
};

// GET /coverage-map/api/constituency/... (kept; assignedConstituencies only)
exports.constituency = async (req, res) => {
  try {
    if (!isSuper(req) && !isSub(req)) return res.status(403).json({ error: 'Access denied.' });
    const geo = await loadGeo();
    const reporters = await permittedReporters(req);
    const allowed = await permittedStates(req, geo, reporters);
    const state = String(req.params.state || '');
    const cons = String(req.params.constituency || '');
    if (allowed && !allowed.has(state)) return res.status(403).json({ error: 'Not in your coverage.' });
    const assigned = reporters.filter((r) => (r.assignedConstituencies || []).some((c) => norm(c) === norm(cons)));
    const b = istBoundaryObjIds();
    const counts = await newsCounts(assigned.map((r) => String(r._id)), b);
    const rows = assigned.map((r) => { const c = counts.get(String(r._id)) || { today: 0, week: 0 };
      return { name: r.name || '', mobile: r.mobileNumber || '', tier: tierLabel(r), today: c.today, week: c.week, status: statusOf(r) }; });
    res.json({ state, district: String(req.params.district || ''), constituency: cons, assignmentPending: rows.length === 0, reporters: rows });
  } catch (e) { console.error('coverage constituency error:', e.message); res.status(500).json({ error: 'Failed to load constituency.' }); }
};

exports._internals = { reporterStateList, istBoundaryObjIds, norm, tierLabel };
