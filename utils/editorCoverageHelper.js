/**
 * Shared logic for reporter geography coverage and sub-editor approval scope.
 * Keeps backward compatibility with assignedLocations / managedLocations / assignedState.
 */

function uniqueStrings(arr) {
  if (!arr) return [];
  const list = Array.isArray(arr) ? arr : [arr];
  return [...new Set(list.map(v => (v || '').toString().trim()).filter(Boolean))];
}

function normalizeApprovalScope(scope) {
  if (!scope || scope === 'all') return 'all';
  if (scope === 'reporters') return 'reporters';
  // Combined: geography coverage AND individually-selected reporters (union).
  if (scope === 'geography_and_reporters') return 'geography_and_reporters';
  // legacy "locations" and new "geography" behave the same
  return 'geography';
}

function getReporterCoverage(reporter) {
  const doc = reporter?.toObject ? reporter.toObject() : reporter || {};
  const states = uniqueStrings([
    ...(doc.assignedStates || []),
    ...(doc.assignedState ? [doc.assignedState] : [])
  ]);
  const districts = uniqueStrings(doc.assignedDistricts || []);
  const constituencies = uniqueStrings([
    ...(doc.assignedConstituencies || []),
    ...(doc.constituency ? [doc.constituency] : [])
  ]);
  const locations = uniqueStrings(doc.assignedLocations || []);
  return { states, districts, constituencies, locations };
}

function computeAssignedLocations({ states = [], districts = [], constituencies = [], legacyLocations = [] } = {}) {
  return uniqueStrings([
    ...states,
    ...districts,
    ...constituencies,
    ...legacyLocations
  ]);
}

function hasOverlap(a, b) {
  if (!a?.length || !b?.length) return false;
  const set = new Set(b);
  return a.some(x => set.has(x));
}

function reporterMatchesCoverage(reporter, coverage = {}) {
  const reporterIds = uniqueStrings(coverage.reporterIds || coverage.managedReporterIds || []);
  if (reporterIds.length) {
    const id = (reporter._id || reporter.id || '').toString();
    return reporterIds.includes(id);
  }

  const states = uniqueStrings(coverage.states || coverage.managedStates || []);
  const districts = uniqueStrings(coverage.districts || coverage.managedDistricts || []);
  const constituencies = uniqueStrings(coverage.constituencies || coverage.managedConstituencies || []);
  const locations = uniqueStrings(coverage.locations || coverage.managedLocations || []);

  if (!states.length && !districts.length && !constituencies.length && !locations.length) {
    return false;
  }

  const r = getReporterCoverage(reporter);

  if (hasOverlap(r.states, states)) return true;
  if (hasOverlap(r.districts, districts)) return true;
  if (hasOverlap(r.constituencies, constituencies)) return true;
  if (hasOverlap(r.locations, locations)) return true;

  const legacyLocation = reporter.location || '';
  if (legacyLocation) {
    const allNames = uniqueStrings([...states, ...districts, ...constituencies, ...locations]);
    if (allNames.includes(legacyLocation)) return true;
  }

  return false;
}

function newsLocationMatchesCoverage(newsLocation, coverage = {}) {
  if (!newsLocation) return false;
  const names = uniqueStrings([
    ...(coverage.states || coverage.managedStates || []),
    ...(coverage.districts || coverage.managedDistricts || []),
    ...(coverage.constituencies || coverage.managedConstituencies || []),
    ...(coverage.locations || coverage.managedLocations || [])
  ]);
  return names.includes(newsLocation);
}

function mergeQuery(base, clause) {
  if (!base || Object.keys(base).length === 0) return clause;
  if (base.$and) return { ...base, $and: [...base.$and, clause] };
  return { $and: [base, clause] };
}

function getAdminId(doc) {
  if (!doc) return '';
  return (doc._id || doc.id || '').toString();
}

/** Approval geography from permissions only — never falls back to news-posting areas. */
function getSubEditorManagedCoverage(subEditorDoc) {
  const perms = subEditorDoc?.permissions || {};
  return {
    states: uniqueStrings(perms.managedStates || []),
    districts: uniqueStrings(perms.managedDistricts || []),
    constituencies: uniqueStrings(perms.managedConstituencies || []),
    locations: uniqueStrings(perms.managedLocations || [])
  };
}

/** Display / legacy helper — may include posting-area fallback for analytics UI. */
function getSubEditorApprovalCoverage(subEditorDoc) {
  const managed = getSubEditorManagedCoverage(subEditorDoc);
  const hasManaged = managed.states.length || managed.districts.length ||
    managed.constituencies.length || managed.locations.length;

  if (hasManaged) return managed;

  return {
    states: uniqueStrings([
      ...(subEditorDoc?.assignedStates || []),
      ...(subEditorDoc?.assignedState ? [subEditorDoc.assignedState] : [])
    ]),
    districts: uniqueStrings(subEditorDoc?.assignedDistricts || []),
    constituencies: uniqueStrings([
      ...(subEditorDoc?.assignedConstituencies || []),
      ...(subEditorDoc?.constituency ? [subEditorDoc.constituency] : [])
    ]),
    locations: uniqueStrings(subEditorDoc?.assignedLocations || [])
  };
}

/** Whether this sub-editor has an explicit team (reporters to manage), not implicit "all". */
function subEditorHasTeamScope(subEditorDoc) {
  if (!subEditorDoc || subEditorDoc.role !== 'subeditor') return false;
  const perms = subEditorDoc.permissions || {};
  if (perms.canViewAllNews) return false;

  const scope = normalizeApprovalScope(perms.approvalScope);
  if (scope === 'all') return perms.canApproveNews === true;
  if (scope === 'reporters') {
    return uniqueStrings(perms.managedReporterIds || []).length > 0;
  }

  const coverage = getSubEditorManagedCoverage(subEditorDoc);
  const hasGeo = !!(coverage.states.length || coverage.districts.length ||
    coverage.constituencies.length || coverage.locations.length);
  if (scope === 'geography_and_reporters') {
    return hasGeo || uniqueStrings(perms.managedReporterIds || []).length > 0;
  }
  return hasGeo;
}

/**
 * Reporter IDs a sub-editor can manage when canViewAllNews is off.
 * Returns null = unrestricted (canViewAllNews on).
 */
async function getManagedReporterIds(Admin, subEditorDoc, options = {}) {
  if (!subEditorDoc || subEditorDoc.role !== 'subeditor') return null;
  const perms = subEditorDoc.permissions || {};
  if (perms.canViewAllNews && !options.ignoreCanViewAllNews) return null;

  const scope = normalizeApprovalScope(perms.approvalScope);

  if (scope === 'all') {
    if (!perms.canApproveNews) return [];
    const all = await Admin.find({ role: 'editor', isActive: { $ne: false } }).select('_id').lean();
    return all.map(r => r._id.toString());
  }

  if (scope === 'reporters') {
    return uniqueStrings(perms.managedReporterIds || []);
  }

  const explicitIds = uniqueStrings(perms.managedReporterIds || []);
  const coverage = getSubEditorManagedCoverage(subEditorDoc);
  const hasGeo = !!(coverage.states.length || coverage.districts.length ||
    coverage.constituencies.length || coverage.locations.length);

  // Pure geography with no coverage → nobody. (Combined scope still uses explicitIds.)
  if (!hasGeo) {
    return scope === 'geography_and_reporters' ? explicitIds : [];
  }

  const reporters = await Admin.find({ role: 'editor', isActive: { $ne: false } })
    .select('_id assignedStates assignedState assignedDistricts assignedConstituencies assignedLocations location constituency')
    .lean();
  const geoIds = reporters.filter(r => reporterMatchesCoverage(r, coverage)).map(r => r._id.toString());

  // Combined = geography-matched reporters UNION the individually-selected reporters.
  if (scope === 'geography_and_reporters') return uniqueStrings([...geoIds, ...explicitIds]);
  return geoIds;
}

function buildSubEditorTabQuery(tab, adminId, reporterIds, options = {}) {
  if (tab === 'my-list') {
    return { authorId: adminId };
  }

  if (reporterIds === null) {
    return { authorId: { $ne: adminId } };
  }

  const teamIds = uniqueStrings(reporterIds || []).filter(id => id !== adminId);
  if (!teamIds.length) {
    return { authorId: '__no_team_reporters__' };
  }
  return { authorId: { $in: teamIds } };
}

async function resolveSubEditorNewsTab(Admin, NewsModel, subEditorDoc, requestedTab, options = {}) {
  if (requestedTab === 'my-list' || requestedTab === 'team-list') {
    return requestedTab;
  }

  const adminId = getAdminId(subEditorDoc);
  const ownCount = await NewsModel.countDocuments({ authorId: adminId });
  if (ownCount > 0) return 'my-list';

  const reporterIds = await getManagedReporterIds(Admin, subEditorDoc, options);
  if (reporterIds === null) return 'team-list';

  if (!reporterIds.length) return 'my-list';

  const teamCount = await NewsModel.countDocuments({ authorId: { $in: reporterIds } });
  return teamCount > 0 ? 'team-list' : 'my-list';
}

async function buildSubEditorAuthorFilter(Admin, subEditorDoc, options = {}) {
  const reporterIds = await getManagedReporterIds(Admin, subEditorDoc, options);
  if (reporterIds === null && !options.ignoreCanViewAllNews) return null;

  const subId = getAdminId(subEditorDoc);
  if (reporterIds === null) {
    return { authorId: { $ne: subId } };
  }
  if (!reporterIds.length) {
    return { authorId: subId };
  }
  return { $or: [{ authorId: subId }, { authorId: { $in: reporterIds } }] };
}

async function buildPendingNewsFilterForSubEditor(Admin, subEditorDoc, baseQuery = {}) {
  if (!subEditorDoc || subEditorDoc.role !== 'subeditor') return baseQuery;
  const perms = subEditorDoc.permissions || {};
  if (perms.canViewAllNews) return baseQuery;

  const reporterIds = await getManagedReporterIds(Admin, subEditorDoc);
  if (!reporterIds.length) {
    return { ...baseQuery, authorId: '__no_managed_reporters__' };
  }

  const scope = normalizeApprovalScope(perms.approvalScope);
  const orClauses = [{ authorId: { $in: reporterIds } }];

  if (scope === 'geography' || scope === 'geography_and_reporters') {
    const coverage = getSubEditorManagedCoverage(subEditorDoc);
    const locationNames = uniqueStrings([
      ...coverage.states,
      ...coverage.districts,
      ...coverage.constituencies,
      ...coverage.locations
    ]);
    if (locationNames.length) {
      orClauses.push({ location: { $in: locationNames } });
    }
  }

  return mergeQuery(baseQuery, { $or: orClauses });
}

function applyReporterCoverageFields(editor, body = {}) {
  const states = uniqueStrings(body.assignedStates);
  if (body.assignedState && !states.includes(body.assignedState)) {
    states.unshift(body.assignedState);
  }
  editor.assignedStates = states;
  editor.assignedState = states[0] || null;

  editor.assignedDistricts = uniqueStrings(body.assignedDistricts);
  editor.assignedConstituencies = uniqueStrings(body.assignedConstituencies);

  if (body.constituency !== undefined) {
    editor.constituency = body.constituency || null;
  } else if (editor.assignedConstituencies.length && !editor.constituency) {
    editor.constituency = editor.assignedConstituencies[0];
  }

  const oldStates = editor.assignedStates || [];
  const oldDist = editor.assignedDistricts || [];
  const oldConst = editor.assignedConstituencies || [];

  const legacy = body.assignedLocations !== undefined
    ? uniqueStrings(body.assignedLocations)
    : (editor.assignedLocations || []).filter(loc => 
        !oldStates.includes(loc) && 
        !oldDist.includes(loc) && 
        !oldConst.includes(loc) &&
        loc !== editor.assignedState &&
        loc !== editor.location
      );

  editor.assignedLocations = computeAssignedLocations({
    states: editor.assignedStates,
    districts: editor.assignedDistricts,
    constituencies: editor.assignedConstituencies,
    legacyLocations: legacy
  });

  if (editor.assignedDistricts[0]) {
    editor.location = editor.assignedDistricts[0];
  } else if (editor.assignedStates[0]) {
    editor.location = editor.assignedStates[0];
  } else if (editor.assignedLocations[0]) {
    editor.location = editor.assignedLocations[0];
  }
}

function applySubEditorCoveragePermissions(editor, body = {}) {
  if (!editor.permissions) editor.permissions = {};

  let scope = body.approvalScope || editor.permissions.approvalScope || 'reporters';
  if (scope === 'locations') scope = 'geography';
  editor.permissions.approvalScope = scope;

  editor.permissions.managedStates = uniqueStrings(body.managedStates);
  editor.permissions.managedDistricts = uniqueStrings(body.managedDistricts);
  editor.permissions.managedConstituencies = uniqueStrings(body.managedConstituencies);
  editor.permissions.managedReporterIds = uniqueStrings(body.managedReporterIds);

  const oldManagedStates = editor.permissions.managedStates || [];
  const oldManagedDist = editor.permissions.managedDistricts || [];
  const oldManagedConst = editor.permissions.managedConstituencies || [];

  const legacyManaged = body.managedLocations !== undefined
    ? uniqueStrings(body.managedLocations)
    : (editor.permissions.managedLocations || []).filter(loc => 
        !oldManagedStates.includes(loc) && 
        !oldManagedDist.includes(loc) && 
        !oldManagedConst.includes(loc)
      );

  editor.permissions.managedLocations = computeAssignedLocations({
    states: editor.permissions.managedStates,
    districts: editor.permissions.managedDistricts,
    constituencies: editor.permissions.managedConstituencies,
    legacyLocations: legacyManaged
  });
}

/**
 * Mirror a sub-editor's APPROVAL geography onto the areas they were actually
 * allocated (assigned* fields), so "the districts I gave = the districts whose
 * reporters they can approve".
 *
 * Rule (only applied when approvalScope resolves to 'geography'):
 *   - managedDistricts      := assignedDistricts
 *   - managedConstituencies := assignedConstituencies (+ legacy `constituency`)
 *   - managedStates         := assignedStates that own NO assigned district
 *       (a state with specific districts is covered at district level only, so it
 *        never widens to the whole state; a state with no districts stays whole-state)
 *   - managedLocations      := union of the above
 *
 * 'all' and 'reporters' scopes are left untouched. Requires the Location model to
 * map each assigned district → its parent state (read-only).
 */
async function syncApprovalScopeToAssigned(Location, editorDoc) {
  if (!editorDoc || editorDoc.role !== 'subeditor') return;
  if (!editorDoc.permissions) editorDoc.permissions = {};
  if (normalizeApprovalScope(editorDoc.permissions.approvalScope) !== 'geography') return;

  const districts = uniqueStrings(editorDoc.assignedDistricts || []);
  const constituencies = uniqueStrings([
    ...(editorDoc.assignedConstituencies || []),
    ...(editorDoc.constituency ? [editorDoc.constituency] : [])
  ]);
  const states = uniqueStrings([
    ...(editorDoc.assignedStates || []),
    ...(editorDoc.assignedState ? [editorDoc.assignedState] : [])
  ]);

  // States that already have district-level coverage must not become whole-state.
  let statesWithDistricts = new Set();
  if (districts.length && Location) {
    const rows = await Location.find({ locationType: 'district', name: { $in: districts } })
      .select('parentName').lean();
    statesWithDistricts = new Set(rows.map(r => r.parentName).filter(Boolean));
  }
  const managedStates = states.filter(s => !statesWithDistricts.has(s));

  editorDoc.permissions.managedDistricts = districts;
  editorDoc.permissions.managedConstituencies = constituencies;
  editorDoc.permissions.managedStates = managedStates;
  editorDoc.permissions.managedLocations = computeAssignedLocations({
    states: managedStates,
    districts,
    constituencies,
    legacyLocations: []
  });
  if (editorDoc.markModified) editorDoc.markModified('permissions');
}

/**
 * Reverse of getManagedReporterIds: given a reporter, find the State In-Charge
 * (a Sub-Editor) who routes/manages them, and return read-only contact details.
 * Pure read — never mutates routing. Prefers an explicit managedReporterIds match,
 * then a geography-coverage match, then a displayRole containing "State In-Charge".
 *
 * @returns {Promise<{name:string, mobileNumber:string}|null>}
 */
async function findReporterStateInchargeDoc(Admin, reporterDoc) {
  if (!reporterDoc) return null;
  const reporterId = getAdminId(reporterDoc);

  const subEditors = await Admin.find({ role: 'subeditor', isActive: { $ne: false } })
    .select('name username displayRole mobileNumber permissions')
    .lean();

  const isBureau = (s) => /bureau/i.test(s.displayRole || '');

  const explicitMatches = [];
  const geoMatches = [];
  for (const s of subEditors) {
    const coverage = getSubEditorManagedCoverage(s);
    const explicitIds = uniqueStrings(s.permissions?.managedReporterIds || []);
    if (explicitIds.includes(reporterId)) {
      explicitMatches.push(s);
    } else if (reporterMatchesCoverage(reporterDoc, coverage)) {
      geoMatches.push(s);
    }
  }

  return (
    explicitMatches.find(isBureau) ||
    geoMatches.find(isBureau) ||
    null
  );
}

async function resolveReporterStateIncharge(Admin, reporterDoc) {
  const pick = await findReporterStateInchargeDoc(Admin, reporterDoc);
  if (!pick) return null;
  return {
    name: pick.name || pick.username || 'State In-Charge',
    mobileNumber: pick.mobileNumber || '',
  };
}

module.exports = {
  uniqueStrings,
  normalizeApprovalScope,
  resolveReporterStateIncharge,
  findReporterStateInchargeDoc,
  syncApprovalScopeToAssigned,
  getAdminId,
  getSubEditorManagedCoverage,
  getSubEditorApprovalCoverage,
  subEditorHasTeamScope,
  getReporterCoverage,
  computeAssignedLocations,
  reporterMatchesCoverage,
  newsLocationMatchesCoverage,
  getManagedReporterIds,
  buildSubEditorTabQuery,
  resolveSubEditorNewsTab,
  buildSubEditorAuthorFilter,
  buildPendingNewsFilterForSubEditor,
  applyReporterCoverageFields,
  applySubEditorCoveragePermissions,
  mergeQuery
};
