'use strict';

/**
 * Reporter "location status" for Step 2/4 of the in-app reporting flow.
 * READ-ONLY. Scope is derived SERVER-SIDE from the authenticated reporter
 * (same as the village search) and the requested place MUST belong to the
 * reporter's own district — a client can never look up another district.
 *
 * Data reused (nothing invented):
 *  - GeoLocation (place, mandal count)                     → existing geo data
 *  - Admin.assignedDistricts (reporters covering district) → same rule as coverage map
 *  - News per reporter today/7d/30d (IST buckets)          → same aggregation as coverage map
 *  - News tagged with this area's name (last 30 days)      → News.location
 *
 * "Opportunity" is a PROVISIONAL, transparent rule over real counts (reporter
 * density per mandal), env-tunable; the rule metadata is returned so the UI and
 * product owner can see exactly how the percentage was derived.
 */

const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const News = require('../models/News');
const GeoLocation = require('../models/GeoLocation');
const { istDayRange } = require('../utils/indianDateTime');
const { reporterGeoScope, unitForCode } = require('../services/reporterGeoScope');

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const numEnv = (k, fb) => { const n = parseFloat(process.env[k]); return Number.isFinite(n) ? n : fb; };

/** Pure: opportunity from the AREA's news posted TODAY — more news posted here
 *  today → LOWER opportunity for fresh news. A smooth exponential decay clamped
 *  to [minPercent … maxPercent] (default 10 … 90) means the gauge is always
 *  DYNAMIC and never shows a flat 0% or 100%. All knobs env-tunable.
 *  Exported for tests. */
function computeOpportunity(newsToday, env = process.env) {
  const num = (k, fb) => { const n = parseFloat(env[k]); return Number.isFinite(n) ? n : fb; };
  // decay 10 → High for 0–4 news, Medium for 5–11, LOW starts at 12+ (today).
  const decay = (() => { const n = num('REPORTER_OPP_DECAY', 10); return n > 0 ? n : 10; })();
  const minP = num('REPORTER_OPP_MIN', 10);      // never below 10%
  const maxP = num('REPORTER_OPP_MAX', 90);      // never above 90%
  const highMin = num('REPORTER_OPP_HIGH_MIN', 60);
  const medMin = num('REPORTER_OPP_MED_MIN', 30);
  const count = Math.max(0, Number(newsToday) || 0);
  let percent = Math.round(maxP * Math.exp(-count / decay));
  percent = Math.max(minP, Math.min(maxP, percent));
  const band = percent >= highMin ? 'high' : percent >= medMin ? 'medium' : 'low';
  return {
    percent,
    band,
    rule: { name: 'area_news_today', newsToday: count, decay, minPercent: minP, maxPercent: maxP, highMin, medMin, provisional: true },
  };
}

function istBoundaryObjIds(now = Date.now()) {
  const day = 24 * 3600 * 1000;
  const oid = (d) => mongoose.Types.ObjectId.createFromTime(Math.floor(d.getTime() / 1000));
  return {
    today: oid(istDayRange(new Date(now)).startUTC),
    week: oid(istDayRange(new Date(now - 6 * day)).startUTC),
    month: oid(istDayRange(new Date(now - 29 * day)).startUTC),
  };
}

/** GET /admin/api/reporter/location-status?code=&type= */
async function locationStatus(req, res) {
  try {
    const reporterId = req.admin && req.admin.id;
    if (!reporterId) return res.status(401).json({ error: 'Not authenticated' });

    const me = await Admin.findById(reporterId).select('assignedState assignedStates assignedDistricts').lean();
    if (!me) return res.status(404).json({ error: 'Reporter not found' });
    // The same area the step 1/4 search offers — every assigned district, not just the first.
    const scope = await reporterGeoScope(me);
    const { state } = scope;
    if (!scope.districts.length) return res.json({ success: true, assigned: false });
    if (!scope.mapped) return res.json({ success: true, assigned: true, mapped: false, district: scope.districts[0], state });

    // The selected place — must be inside the reporter's own area.
    const code = String((req.query && req.query.code) || '').trim();
    const type = String((req.query && req.query.type) || 'village').trim();
    if (!code || !['village', 'mandal', 'district'].includes(type)) return res.status(400).json({ error: 'code and type (village|mandal|district) are required' });

    let place;
    let unit;
    if (type === 'district') {
      // The district's own HQ town/city — only the reporter's own district.
      unit = scope.units.find((u) => u.districtCode === code);
      if (!unit) return res.status(404).json({ error: 'Location not found in your district' });
      place = { name: unit.assigned, type: 'district', code, mandalName: '', mandalCode: '', districtName: unit.assigned, stateName: unit.stateName };
    } else {
      place = scope.searchCodes.length
        ? await GeoLocation.findOne({ type, code, districtCode: { $in: scope.searchCodes } })
          .select('name type code mandalName mandalCode districtCode districtName stateName').lean()
        : null;
      if (!place) return res.status(404).json({ error: 'Location not found in your district' });
      unit = unitForCode(scope, place.districtCode);
    }
    const district = unit.assigned;
    // A village reached through a parent district is shown under the reporter's own (new) district.
    const districtLabel = unit.fromParents || type === 'district' ? unit.assigned : (place.districtName || district);
    const mandalCodes = unit.searchCodes.length ? unit.searchCodes : [unit.districtCode];

    const b = istBoundaryObjIds();
    const [reporters, mandals] = await Promise.all([
      Admin.find({ role: 'editor', isActive: { $ne: false }, assignedDistricts: { $in: [district] } }).select('_id').lean(),
      GeoLocation.countDocuments({ type: 'mandal', districtCode: { $in: mandalCodes } }),
    ]);
    const ids = reporters.map((r) => String(r._id));

    // News by those reporters (same aggregation as the coverage map).
    let newsToday = 0, newsWeek = 0, newsMonth = 0;
    if (ids.length) {
      const rows = await News.aggregate([
        { $match: { authorId: { $in: ids }, _id: { $gte: b.month }, 'rejectionStatus.isRejected': { $ne: true } } },
        { $group: { _id: null,
          today: { $sum: { $cond: [{ $gte: ['$_id', b.today] }, 1, 0] } },
          week: { $sum: { $cond: [{ $gte: ['$_id', b.week] }, 1, 0] } },
          month: { $sum: 1 } } },
      ]);
      if (rows[0]) { newsToday = rows[0].today; newsWeek = rows[0].week; newsMonth = rows[0].month; }
    }

    // News already tagged with this area's name (village or its mandal).
    const areaNames = [...new Set([place.name, place.mandalName].filter(Boolean).map(norm))];
    const areaMatch = (sinceOid) => ({
      _id: { $gte: sinceOid }, isActive: true, 'rejectionStatus.isRejected': { $ne: true },
      $expr: { $in: [{ $toLower: { $ifNull: ['$location', ''] } }, areaNames] },
    });
    const [areaNewsToday, areaNews30d] = areaNames.length
      ? await Promise.all([
          News.countDocuments(areaMatch(b.today)),
          News.countDocuments(areaMatch(b.month)),
        ])
      : [0, 0];

    return res.json({
      success: true,
      assigned: true,
      mapped: true,
      place: {
        name: place.name, type: place.type, code: place.code,
        mandal: place.type === 'village' ? (place.mandalName || '') : '',
        mandalCode: place.mandalCode || '',
        district: districtLabel, state: place.stateName || state,
      },
      district: { name: district, state, reporters: ids.length, mandals, newsToday, newsWeek, newsMonth },
      area: { newsToday: areaNewsToday, newsLast30Days: areaNews30d },
      // Opportunity reflects the AREA's news posted TODAY — more news today →
      // lower opportunity, always dynamic within 10–90%.
      opportunity: computeOpportunity(areaNewsToday),
    });
  } catch (err) {
    console.error('[reporter][location-status] failed:', err && err.message);
    return res.status(500).json({ error: 'Could not load location status. Please try again.' });
  }
}

module.exports = { locationStatus, computeOpportunity };
