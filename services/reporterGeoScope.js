'use strict';

/**
 * Where a reporter may file news from — ONE answer shared by the step 1/4 place
 * search and the step 2/4 status check, so any place the search offers is a place
 * the status check accepts.
 *
 * Built only from what the admin assigned (state + districts) and the fixed tables
 * below — never from the client. For each assigned district:
 *   1. Find its GeoLocation (LGD) district: by name within the state (spelling
 *      tolerant); renamed districts via ALIASES (Kadapa → "Y.S.R."); a district
 *      filed under the wrong state (Ghaziabad under "Delhi") by its exact name in
 *      the reporter's other states, or anywhere if that name is unique in India.
 *   2. Decide what to search: that district's own villages/mandals — or, when the
 *      LGD data has none (districts created after it was published: Kakinada,
 *      Tirupati, Maihar …), the villages of the districts it was carved from (PARENTS).
 * The district itself is also a place ("Gwalior — District HQ / City"): the LGD
 * data has no town/city rows, so a city was otherwise impossible to pick.
 */

const GeoLocation = require('../models/GeoLocation');

const HQ_LABEL = 'District HQ / City';

/** Alphanumeric-only lowercase key for tolerant name comparison. */
function normName(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Classic Levenshtein edit distance (small strings). */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

/** Resolve the reporter's assigned {stateName, districtName} → GeoLocation
 *  districtCode. Returns null when it cannot be mapped.
 *
 *  Tolerant to spelling variants (e.g. "Mahbubnagar" vs geo "Mahabubnagar"):
 *  after an exact miss it fuzzy-matches WITHIN the reporter's state only, so a
 *  reporter still can't reach a district outside their assigned state. */
async function resolveDistrictCode(stateName, districtName) {
  const dName = String(districtName || '').trim().toLowerCase();
  if (!dName) return null;

  // Scope by state when we can map it (district names repeat across states).
  let stateCode = '';
  const sName = String(stateName || '').trim().toLowerCase();
  if (sName) {
    const st = await GeoLocation.findOne({ type: 'state', search: sName })
      .select('code').lean();
    if (st) stateCode = st.code;
  }

  // 1) Exact normalized-name match.
  const exactFilter = { type: 'district', search: dName };
  if (stateCode) exactFilter.stateCode = stateCode;
  const exact = await GeoLocation.findOne(exactFilter).select('code').lean();
  if (exact) return exact.code;

  // 2) Tolerant match within the SAME state (spelling variants). State-bounded
  //    so it never resolves to a district the reporter isn't assigned to.
  if (stateCode) {
    const dists = await GeoLocation.find({ type: 'district', stateCode })
      .select('code name search').lean();
    const target = normName(dName);
    if (target) {
      // Rank matches so the MOST SPECIFIC district wins — never just the first
      // substring hit. Priority:
      //   1. exact
      //   2. the LONGEST geo name contained in the assigned name
      //      ("North East Delhi" → "NORTH EAST", not "EAST" or "NORTH")
      //   3. the geo name that best CONTAINS the assigned name
      //      ("Nellore" → "SPSR NELLORE"), closest in length
      //   4. closest by edit distance (spelling variants)
      let insideAssigned = null, insideLen = -1;   // geo name inside the assigned name (longest)
      let wrapsAssigned = null, wrapsExtra = Infinity; // geo name that contains the assigned name (tightest)
      let edBest = null, edDist = Infinity;
      for (const d of dists) {
        const cand = normName(d.search || d.name);
        if (!cand) continue;
        if (cand === target) return d.code;
        if (target.includes(cand) && cand.length > insideLen) { insideLen = cand.length; insideAssigned = d; }
        else if (cand.includes(target) && (cand.length - target.length) < wrapsExtra) { wrapsExtra = cand.length - target.length; wrapsAssigned = d; }
        const dist = levenshtein(target, cand);
        if (dist < edDist) { edDist = dist; edBest = d; }
      }
      if (insideAssigned) return insideAssigned.code;
      if (wrapsAssigned) return wrapsAssigned.code;
      const threshold = Math.max(2, Math.round(target.length * 0.2));
      if (edBest && edDist <= threshold) return edBest.code;
    }
  }
  return null;
}

/** Renamed districts: the name a reporter is assigned → [state, LGD name]. */
const ALIASES = (() => {
  const t = {};
  const add = (keys, state, lgd) => keys.forEach((k) => { t[k] = [state, lgd]; });
  add(['kadapa', 'ysrkadapa', 'cuddapah', 'ysr', 'ysrdistrict'], 'andhra pradesh', 'y.s.r.');
  add(['thoothukudi', 'thoothukkudi', 'tuticorin'], 'tamil nadu', 'tuticorin');
  add(['khandwa'], 'madhya pradesh', 'east nimar');
  add(['eastchamparan', 'purvichamparan', 'purbichamparan'], 'bihar', 'purbi champaran');
  add(['westchamparan', 'paschimchamparan', 'pashchimchamparan'], 'bihar', 'pashchim champaran');
  add(['chhatrapatisambhajinagar', 'sambhajinagar'], 'maharashtra', 'aurangabad');
  add(['dharashiv'], 'maharashtra', 'osmanabad');
  add(['sahibzadaajitsinghnagar', 'mohali', 'sasnagar', 'sasnagarmohali'], 'punjab', 's.a.s nagar');
  // Districts whose reporter-assigned name differs from the LGD spelling — map
  // each to the exact LGD `search` value so the scope resolves reliably.
  add(['nellore'], 'andhra pradesh', 'spsr nellore');
  add(['visakhapatnam', 'vizag', 'visakha'], 'andhra pradesh', 'visakhapatanam');
  add(['kaimur', 'bhabua'], 'bihar', 'kaimur (bhabua)');
  add(['banaskantha'], 'gujarat', 'banas kantha');
  add(['sahibganj'], 'jharkhand', 'sahebganj');
  add(['eastsinghbhum', 'purbisinghbhum', 'jamshedpur'], 'jharkhand', 'east singhbum');
  add(['seraikelakharsawan', 'saraikelakharsawan', 'seraikela', 'saraikela'], 'jharkhand', 'saraikela kharsawan');
  add(['mahbubnagar'], 'telangana', 'mahabubnagar');
  add(['rangareddy', 'rangareddi'], 'telangana', 'ranga reddy');
  add(['medchalmalkajgiri', 'medchal', 'malkajgiri'], 'telangana', 'medchal malkajgiri');
  add(['jagtial'], 'telangana', 'jagitial');
  add(['jayashankarbhupalpally', 'bhupalpally', 'jayashankar'], 'telangana', 'jayashankar bhupalapally');
  add(['muktsar', 'srimuktsarsahib'], 'punjab', 'sri muktsar sahib');
  add(['lakhimpurkheri', 'lakhimpur', 'kheri'], 'uttar pradesh', 'kheri');
  add(['raebareli', 'raibareli'], 'uttar pradesh', 'rae bareli');
  add(['kushinagar'], 'uttar pradesh', 'kushi nagar');
  add(['udhamsinghnagar', 'udamsinghnagar', 'rudrapur'], 'uttarakhand', 'udam singh nagar');
  add(['janjgirchampa', 'janjgir', 'champa'], 'chhattisgarh', 'janjgir-champa');
  add(['eastdelhi'], 'delhi', 'east');
  add(['chandigarhcity', 'chandigarh'], 'chandigarh', 'chandigarh');
  return t;
})();

/** Districts created after the LGD village data was published → [state, the LGD
 *  districts they were carved from]. The Andhra Pradesh rows were checked against
 *  our own constituency list: each new district's constituencies are mandals of
 *  these parents. A slightly wider search beats a search that finds nothing. */
const PARENTS = (() => {
  const t = {};
  const add = (keys, state, parents) => keys.forEach((k) => { t[k] = [state, parents]; });
  const AP = 'andhra pradesh';
  add(['kakinada'], AP, ['east godavari']);
  add(['konaseema', 'drbrambedkarkonaseema', 'ambedkarkonaseema', 'brambedkarkonaseema'], AP, ['east godavari']);
  add(['eluru'], AP, ['west godavari', 'krishna']);
  add(['ntr', 'ntrdistrict'], AP, ['krishna']);
  add(['palnadu'], AP, ['guntur']);
  add(['bapatla'], AP, ['guntur', 'prakasam']);
  add(['tirupati'], AP, ['chittoor', 'spsr nellore']);
  add(['annamayya'], AP, ['y.s.r.', 'chittoor']);
  add(['srisathyasai', 'sathyasai'], AP, ['anantapur']);
  add(['nandyal'], AP, ['kurnool']);
  add(['anakapalli', 'anakapalle'], AP, ['visakhapatanam']);
  add(['allurisitharamaraju', 'asr'], AP, ['visakhapatanam', 'east godavari']);
  add(['parvathipurammanyam', 'manyam'], AP, ['vizianagaram', 'srikakulam']);
  add(['markapuram', 'markapur'], AP, ['prakasam']);
  add(['maihar'], 'madhya pradesh', ['satna']);
  add(['balotra'], 'rajasthan', ['barmer']);
  add(['deeg'], 'rajasthan', ['bharatpur']);
  add(['beawar'], 'rajasthan', ['ajmer', 'pali']);
  add(['dudu'], 'rajasthan', ['jaipur']);
  add(['gariaband', 'gariyaband'], 'chhattisgarh', ['raipur']);
  return t;
})();

async function hasPlaces(districtCode) {
  if (!districtCode) return false;
  return !!(await GeoLocation.findOne({ type: { $in: ['village', 'mandal'] }, districtCode }).select('_id').lean());
}

/** Find the LGD district for one assigned district name. → { code, via } */
async function findDistrict(state, otherStates, assigned) {
  const alias = ALIASES[normName(assigned)];
  if (alias) {
    const code = await resolveDistrictCode(alias[0], alias[1]);
    if (code) return { code, via: 'alias' };
  }
  const own = await resolveDistrictCode(state, assigned);
  if (own) return { code: own, via: 'name' };
  for (const st of otherStates) {
    if (!st || st === state) continue;
    const code = await resolveDistrictCode(st, assigned);
    if (code) return { code, via: 'other-state' };
  }
  // Filed under the wrong state: accept an exact name only when it is unique in India.
  const exact = await GeoLocation.find({ type: 'district', search: String(assigned).trim().toLowerCase() }).select('code').limit(2).lean();
  if (exact.length === 1) return { code: exact[0].code, via: 'unique-name' };
  return { code: null, via: 'none' };
}

// The LGD data never changes and the key holds the whole assignment, so a short
// cache is always correct; it saves ~6 queries per keystroke of the search box.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();
function _clearScopeCache() { cache.clear(); }

/**
 * The reporter's filing area.
 * @param {{assignedState?, assignedStates?, assignedDistricts?}} reporter  Admin doc
 * @returns {{ state, districts, units, searchCodes, mapped }}
 *   units: one per assigned district — { assigned, districtCode, districtName,
 *   stateName, searchCodes, fromParents, via }. districtCode is null when the LGD
 *   data has no such district; searchCodes are the LGD districts whose villages
 *   and mandals may be searched.
 */
async function reporterGeoScope(reporter) {
  const r = reporter || {};
  const states = Array.isArray(r.assignedStates) ? r.assignedStates.filter(Boolean) : [];
  const state = r.assignedState || states[0] || '';
  const districts = Array.isArray(r.assignedDistricts) ? r.assignedDistricts.filter(Boolean) : [];
  const key = JSON.stringify([state, states, districts]);
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.scope;

  const units = [];
  for (const assigned of districts) {
    const { code, via } = await findDistrict(state, states, assigned);
    const geo = code ? await GeoLocation.findOne({ type: 'district', code }).select('name stateName').lean() : null;
    let searchCodes = [];
    let fromParents = false;
    if (code && await hasPlaces(code)) {
      searchCodes = [code];
    } else {
      const p = PARENTS[normName(assigned)] || (geo && PARENTS[normName(geo.name)]);
      if (p) {
        for (const parent of p[1]) {
          const pc = await resolveDistrictCode(p[0], parent);
          if (pc && !searchCodes.includes(pc)) searchCodes.push(pc);
        }
        fromParents = searchCodes.length > 0;
      }
    }
    units.push({
      assigned: String(assigned).trim(),
      districtCode: code || null,
      districtName: (geo && geo.name) || '',
      stateName: (geo && geo.stateName) || '',
      searchCodes, fromParents, via,
    });
  }

  const searchCodes = [...new Set(units.flatMap((u) => u.searchCodes))];
  const scope = {
    state, districts, units, searchCodes,
    // Something to pick: villages to search, or at least the district itself.
    mapped: units.some((u) => u.searchCodes.length || u.districtCode),
  };
  if (cache.size > 2000) cache.clear();
  cache.set(key, { at: Date.now(), scope });
  return scope;
}

/** The unit a searched row belongs to (by the row's LGD districtCode). */
function unitForCode(scope, districtCode) {
  return scope.units.find((u) => u.districtCode === districtCode && !u.fromParents)
    || scope.units.find((u) => u.searchCodes.includes(districtCode))
    || null;
}

/** Does the typed text start the district's name? ("gwal" → Gwalior). Empty = yes. */
function districtMatches(unit, q) {
  const k = normName(q);
  if (!k) return true;
  return [unit.assigned, unit.districtName].some((n) => normName(n).startsWith(k));
}

module.exports = {
  HQ_LABEL, ALIASES, PARENTS,
  normName, levenshtein, resolveDistrictCode,
  reporterGeoScope, unitForCode, districtMatches, _clearScopeCache,
};
