'use strict';

/**
 * Reporter village/locality autocomplete — DISTRICT-SCOPED to the authenticated
 * reporter. READ-ONLY.
 *
 * Reuses the existing `geolocations` source of truth (GeoLocation) and the query
 * pattern from scripts/geo-data/geo-queries.example.js. The district is derived
 * SERVER-SIDE from the authenticated reporter's `assignedDistricts` /
 * `assignedState` — never taken from the client — so a reporter can only ever
 * search villages inside their own assigned district. No new location data.
 * The area itself (aliases, parent districts, the district HQ) comes from
 * services/reporterGeoScope, shared with the step 2/4 status check.
 */

const GeoLocation = require('../models/GeoLocation');
const Admin = require('../models/Admin');
const {
  HQ_LABEL, resolveDistrictCode, reporterGeoScope, unitForCode, districtMatches,
} = require('../services/reporterGeoScope');
const { isIndic, indicNameRegex } = require('../services/indicSearch');

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** GET /admin/api/reporter/villages?q=... — villages in the reporter's district. */
async function searchVillages(req, res) {
  try {
    const reporterId = req.admin && req.admin.id;
    if (!reporterId) return res.status(401).json({ error: 'Not authenticated' });

    // Server-derived scope (authoritative). Never trust a client-sent district.
    const reporter = await Admin.findById(reporterId)
      .select('assignedState assignedStates assignedDistricts')
      .lean();
    if (!reporter) return res.status(404).json({ error: 'Reporter not found' });

    const scope = await reporterGeoScope(reporter);
    const { state, districts } = scope;

    if (!districts.length) {
      return res.json({ success: true, state, district: '', districts: [], assigned: false, villages: [] });
    }

    // Display label: one district → its name; many → the state (or a count).
    const displayDistrict = districts.length === 1 ? districts[0] : (state || `${districts.length} districts`);

    if (!scope.mapped) {
      // Districts assigned but none present in the geo dataset → honest empty.
      return res.json({ success: true, state, district: displayDistrict, districts, assigned: true, mapped: false, villages: [] });
    }

    const q = String((req.query && req.query.q) || '').trim().toLowerCase();
    const rawLimit = parseInt((req.query && req.query.limit) || '', 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 50);

    // The district itself — its HQ town/city. The LGD data has no town rows, so
    // "Gwalior" could not be found any other way. Named as the admin assigned it,
    // so the news location reads "Gwalior", as it always has.
    // When the reporter types in their own script (Hindi/Telugu), match the HQ
    // name by consonant skeleton; a Latin query uses the exact matcher.
    const indicQ = q && isIndic(q);
    const indicRe = indicQ ? indicNameRegex(q) : null;
    const hqMatches = (u) => {
      if (!u.districtCode) return false;
      if (indicQ) return indicRe ? new RegExp(indicRe, 'i').test(String(u.assigned || '')) : false;
      return districtMatches(u, q);
    };
    const hq = scope.units
      .filter(hqMatches)
      .map((u) => ({
        name: u.assigned, code: u.districtCode, type: 'district',
        mandal: HQ_LABEL, mandalCode: '',
        district: u.assigned, state: u.stateName || state,
      }));

    // Village/town autocomplete across ALL of the reporter's searchable districts
    // (indexed prefix match). Mandal rows included so mandal-HQ towns are also
    // selectable — still strictly inside the reporter's own area.
    let rows = [];
    if (scope.searchCodes.length) {
      const filter = { type: { $in: ['village', 'mandal'] }, districtCode: { $in: scope.searchCodes } };
      if (q) {
        // Indic script → fuzzy consonant-skeleton regex; Latin → exact prefix.
        if (indicQ) {
          if (indicRe) filter.search = { $regex: indicRe };
          // too-short Indic query (<2 consonants) → no name filter (show list).
        } else {
          filter.search = { $regex: '^' + escapeRegex(q) };
        }
      }
      rows = await GeoLocation.find(filter)
        .sort({ name: 1 })
        .limit(limit)
        .select('name code type mandalName mandalCode districtCode districtName stateName')
        .lean();
    }

    return res.json({
      success: true,
      state,
      district: displayDistrict,
      districts,
      assigned: true,
      mapped: true,
      // Each row is self-contained (codes + hierarchy) so the next step can use
      // IDs, not just the displayed name.
      villages: [...hq, ...rows.map((r) => {
        // A village found through a parent district belongs to the reporter's
        // new district (Kakinada), not the old one (East Godavari).
        const unit = unitForCode(scope, r.districtCode);
        return {
          name: r.name,
          code: r.code,
          type: r.type,
          mandal: r.type === 'mandal' ? '' : (r.mandalName || ''),
          mandalCode: r.mandalCode || '',
          district: unit && unit.fromParents ? unit.assigned : (r.districtName || (districts.length === 1 ? districts[0] : '')),
          state: r.stateName || state,
        };
      })],
    });
  } catch (err) {
    console.error('[reporter][villages] search failed:', err && err.message);
    return res.status(500).json({ error: 'Could not load locations. Please try again.' });
  }
}

module.exports = { searchVillages, resolveDistrictCode };
