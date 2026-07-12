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

function getSubEditorApprovalCoverage(subEditorDoc) {
  const perms = subEditorDoc?.permissions || {};
  const managedStates = uniqueStrings(perms.managedStates || []);
  const managedDistricts = uniqueStrings(perms.managedDistricts || []);
  const managedConstituencies = uniqueStrings(perms.managedConstituencies || []);
  const managedLocations = uniqueStrings(perms.managedLocations || []);

  const hasManaged = managedStates.length || managedDistricts.length ||
    managedConstituencies.length || managedLocations.length;

  if (hasManaged) {
    return {
      states: managedStates,
      districts: managedDistricts,
      constituencies: managedConstituencies,
      locations: managedLocations
    };
  }

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

/**
 * Reporter IDs a sub-editor can manage when canViewAllNews is off.
 * Returns null = unrestricted (canViewAllNews on).
 */
async function getManagedReporterIds(Admin, subEditorDoc) {
  if (!subEditorDoc || subEditorDoc.role !== 'subeditor') return null;
  const perms = subEditorDoc.permissions || {};
  if (perms.canViewAllNews) return null;

  const scope = normalizeApprovalScope(perms.approvalScope);

  if (scope === 'all') {
    const all = await Admin.find({ role: 'editor', isActive: { $ne: false } }).select('_id').lean();
    return all.map(r => r._id.toString());
  }

  if (scope === 'reporters') {
    return uniqueStrings(perms.managedReporterIds || []);
  }

  const coverage = getSubEditorApprovalCoverage(subEditorDoc);

  const reporters = await Admin.find({ role: 'editor', isActive: { $ne: false } })
    .select('_id assignedStates assignedState assignedDistricts assignedConstituencies assignedLocations location constituency')
    .lean();

  return reporters.filter(r => reporterMatchesCoverage(r, coverage)).map(r => r._id.toString());
}

function buildSubEditorTabQuery(tab, adminId, reporterIds) {
  if (tab === 'my-list') {
    return { authorId: adminId };
  }

  const teamIds = uniqueStrings(reporterIds || []).filter(id => id !== adminId);
  if (!teamIds.length) {
    return { authorId: '__no_team_reporters__' };
  }
  return { authorId: { $in: teamIds } };
}

async function resolveSubEditorNewsTab(Admin, NewsModel, subEditorDoc, requestedTab) {
  if (requestedTab === 'my-list' || requestedTab === 'team-list') {
    return requestedTab;
  }

  const adminId = getAdminId(subEditorDoc);
  const ownCount = await NewsModel.countDocuments({ authorId: adminId });
  if (ownCount > 0) return 'my-list';

  const reporterIds = await getManagedReporterIds(Admin, subEditorDoc);
  if (reporterIds === null) return 'team-list';

  if (!reporterIds.length) return 'my-list';

  const teamCount = await NewsModel.countDocuments({ authorId: { $in: reporterIds } });
  return teamCount > 0 ? 'team-list' : 'my-list';
}

async function buildSubEditorAuthorFilter(Admin, subEditorDoc) {
  const reporterIds = await getManagedReporterIds(Admin, subEditorDoc);
  if (reporterIds === null) return null;

  const subId = getAdminId(subEditorDoc);
  if (!reporterIds.length) {
    return { authorId: subId };
  }
  return { $or: [{ authorId: subId }, { authorId: { $in: reporterIds } }] };
}

async function buildPendingNewsFilterForSubEditor(Admin, subEditorDoc, baseQuery = {}) {
  if (!subEditorDoc || subEditorDoc.role !== 'subeditor') return baseQuery;
  const perms = subEditorDoc.permissions || {};
  if (perms.canViewAllNews) return baseQuery;

  const scope = normalizeApprovalScope(perms.approvalScope);

  if (scope === 'all') return baseQuery;

  if (scope === 'reporters') {
    const ids = uniqueStrings(perms.managedReporterIds || []);
    if (!ids.length) return { ...baseQuery, authorId: '__no_managed_reporters__' };
    return mergeQuery(baseQuery, { authorId: { $in: ids } });
  }

  const reporterIds = await getManagedReporterIds(Admin, subEditorDoc);
  const coverage = getSubEditorApprovalCoverage(subEditorDoc);
  const locationNames = uniqueStrings([
    ...coverage.states,
    ...coverage.districts,
    ...coverage.constituencies,
    ...coverage.locations
  ]);

  const orClauses = [];
  if (locationNames.length) orClauses.push({ location: { $in: locationNames } });
  if (reporterIds.length) orClauses.push({ authorId: { $in: reporterIds } });

  if (!orClauses.length) return { ...baseQuery, authorId: '__no_coverage__' };
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

  const legacy = body.assignedLocations !== undefined
    ? uniqueStrings(body.assignedLocations)
    : (editor.assignedLocations || []);

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

  let scope = body.approvalScope || editor.permissions.approvalScope || 'all';
  if (scope === 'locations') scope = 'geography';
  editor.permissions.approvalScope = scope;

  editor.permissions.managedStates = uniqueStrings(body.managedStates);
  editor.permissions.managedDistricts = uniqueStrings(body.managedDistricts);
  editor.permissions.managedConstituencies = uniqueStrings(body.managedConstituencies);
  editor.permissions.managedReporterIds = uniqueStrings(body.managedReporterIds);

  const legacyManaged = body.managedLocations !== undefined
    ? uniqueStrings(body.managedLocations)
    : (editor.permissions.managedLocations || []);

  editor.permissions.managedLocations = computeAssignedLocations({
    states: editor.permissions.managedStates,
    districts: editor.permissions.managedDistricts,
    constituencies: editor.permissions.managedConstituencies,
    legacyLocations: legacyManaged
  });
}

module.exports = {
  uniqueStrings,
  normalizeApprovalScope,
  getAdminId,
  getSubEditorApprovalCoverage,
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
