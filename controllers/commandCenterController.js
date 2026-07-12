const Admin = require('../models/Admin');
const News = require('../models/News');
let Location;
try { Location = require('../models/Location'); } catch (e) { Location = null; }

async function renderCommandCenter(req, res) {
  try {
    res.render('command-center', { admin: req.admin });
  } catch (error) {
    console.error('Command center error:', error);
    res.status(500).send('Error loading command center');
  }
}

async function getCommandCenterData(req, res) {
  try {
    const { period, startDate, endDate } = req.query;

    const dateFilter = buildDateFilter(period, startDate, endDate);

    const locationQuery = Location ? Location.find({ isActive: true }).select('name localName locationType parentName').lean() : Promise.resolve([]);

    const [
      editors,
      newsByLocation,
      newsByLanguage,
      newsByScope,
      newsByAuthor,
      totalStats,
      dailyTrend,
      newsByCategory,
      locationDocs
    ] = await Promise.all([
      Admin.find({ role: { $in: ['editor', 'subeditor'] } })
        .select('username name email role assignedStates assignedDistricts assignedConstituencies allowedScopes workingLanguage isActive lastLogin constituency displayRole createdAt permissions.approvalScope permissions.managedStates permissions.managedDistricts permissions.managedConstituencies permissions.managedReporterIds permissions.managedLocations')
        .lean(),
      News.aggregate([
        { $match: { ...dateFilter } },
        { $group: { _id: { location: '$location', scope: '$scope' }, count: { $sum: 1 } } }
      ]),
      News.aggregate([
        { $match: { ...dateFilter } },
        { $group: { _id: '$language', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      News.aggregate([
        { $match: { ...dateFilter } },
        { $group: { _id: '$scope', count: { $sum: 1 } } }
      ]),
      News.aggregate([
        { $match: { ...dateFilter } },
        {
          $group: {
            _id: '$authorId',
            count: { $sum: 1 },
            author: { $first: '$author' },
            languages: { $addToSet: '$language' },
            locations: { $addToSet: '$location' },
            scopes: { $addToSet: '$scope' },
            categories: { $addToSet: '$category' },
            published: { $sum: { $cond: ['$isActive', 1, 0] } },
            approved: { $sum: { $cond: ['$approvalStatus.isApproved', 1, 0] } },
            rejected: { $sum: { $cond: ['$rejectionStatus.isRejected', 1, 0] } },
            pending: { $sum: { $cond: [{ $and: [{ $eq: ['$isActive', false] }, { $not: '$rejectionStatus.isRejected' }] }, 1, 0] } },
            views: { $sum: '$views' },
            likes: { $sum: '$likes' },
            lastPosted: { $max: '$publishedAt' }
          }
        },
        { $sort: { count: -1 } }
      ]),
      News.aggregate([
        { $match: { ...dateFilter } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            published: { $sum: { $cond: ['$isActive', 1, 0] } },
            approved: { $sum: { $cond: ['$approvalStatus.isApproved', 1, 0] } },
            rejected: { $sum: { $cond: ['$rejectionStatus.isRejected', 1, 0] } },
            pending: { $sum: { $cond: [{ $and: [{ $eq: ['$isActive', false] }, { $not: '$rejectionStatus.isRejected' }] }, 1, 0] } },
            totalViews: { $sum: '$views' },
            totalLikes: { $sum: '$likes' }
          }
        }
      ]),
      News.aggregate([
        { $match: { ...dateFilter } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$publishedAt' } },
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } },
        { $limit: 90 }
      ]),
      News.aggregate([
        { $match: { ...dateFilter } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      locationQuery
    ]);

    const reporters = editors.filter(e => e.role === 'editor');
    const subEditors = editors.filter(e => e.role === 'subeditor');

    const stateNewsMap = {};
    const districtNewsMap = {};
    newsByLocation.forEach(item => {
      const loc = item._id.location || 'Unknown';
      const scope = item._id.scope || 'state';
      if (scope === 'district') {
        districtNewsMap[loc] = (districtNewsMap[loc] || 0) + item.count;
      }
      stateNewsMap[loc] = (stateNewsMap[loc] || 0) + item.count;
    });

    const stateTeamMap = {};
    editors.forEach(editor => {
      getEditorCoverageStates(editor).forEach(state => {
        if (!stateTeamMap[state]) stateTeamMap[state] = { reporters: [], subEditors: [] };
        if (editor.role === 'editor') stateTeamMap[state].reporters.push(editor);
        else stateTeamMap[state].subEditors.push(editor);
      });
    });

    const unassignedEditors = editors.filter(e => getEditorCoverageStates(e).length === 0);

    const authorMap = {};
    newsByAuthor.forEach(a => { authorMap[a._id] = a; });

    const locationHierarchy = {};
    locationDocs.forEach(loc => {
      if (loc.locationType === 'state') {
        if (!locationHierarchy[loc.name]) locationHierarchy[loc.name] = { districts: [] };
      }
    });
    locationDocs.forEach(loc => {
      if (loc.locationType === 'district') {
        const parentName = loc.parentName;
        if (parentName && locationHierarchy[parentName]) {
          locationHierarchy[parentName].districts.push(loc.name);
        }
      }
    });

    const reporterPerformance = reporters.map(r => {
      const stats = authorMap[r._id.toString()] || {};
      return {
        ...r,
        newsCount: stats.count || 0,
        published: stats.published || 0,
        approved: stats.approved || 0,
        rejected: stats.rejected || 0,
        pending: stats.pending || 0,
        views: stats.views || 0,
        likes: stats.likes || 0,
        newsLanguages: stats.languages || [],
        newsLocations: (stats.locations || []).filter(Boolean),
        newsCategories: stats.categories || [],
        lastPosted: stats.lastPosted || null
      };
    }).sort((a, b) => b.newsCount - a.newsCount);

    const inactiveReporters = reporters.filter(r => {
      const stats = authorMap[r._id.toString()];
      return !stats || stats.count === 0;
    });

    const stats = totalStats[0] || { total: 0, published: 0, approved: 0, rejected: 0, pending: 0, totalViews: 0, totalLikes: 0 };

    const coverageGaps = [];
    Object.keys(locationHierarchy).forEach(state => {
      const team = stateTeamMap[state];
      if (!team || (team.reporters.length === 0 && team.subEditors.length === 0)) {
        coverageGaps.push({ state, type: 'no_team', message: `${state} has no reporters or sub-editors assigned` });
      } else if (team.reporters.length === 0) {
        coverageGaps.push({ state, type: 'no_reporters', message: `${state} has sub-editors but no reporters` });
      }
      const districts = locationHierarchy[state].districts || [];
      districts.forEach(dist => {
        const hasReporter = reporters.some(r => (r.assignedDistricts || []).includes(dist));
        if (!hasReporter) {
          coverageGaps.push({ state, district: dist, type: 'no_district_reporter', message: `${dist} district (${state}) has no reporter` });
        }
      });
    });

    res.json({
      summary: stats,
      stateNewsMap,
      districtNewsMap,
      newsByLanguage: newsByLanguage.map(l => ({ language: l._id || 'unknown', count: l.count })),
      newsByScope: newsByScope.map(s => ({ scope: s._id || 'unknown', count: s.count })),
      newsByCategory: newsByCategory.map(c => ({ category: c._id || 'unknown', count: c.count })),
      stateTeamMap,
      locationHierarchy,
      reporterPerformance,
      subEditors: subEditors.map(se => normalizeSubEditorForView(se, authorMap[se._id.toString()] || {})),
      unassignedEditors,
      inactiveReporters: inactiveReporters.map(r => ({
        _id: r._id, name: r.name || r.username, email: r.email,
        assignedStates: r.assignedStates, lastLogin: r.lastLogin
      })),
      coverageGaps,
      dailyTrend,
      teamCount: {
        totalReporters: reporters.length,
        totalSubEditors: subEditors.length,
        activeReporters: reporters.filter(r => r.isActive !== false).length,
        activeSubEditors: subEditors.filter(s => s.isActive !== false).length,
        inactiveCount: inactiveReporters.length,
        unassignedCount: unassignedEditors.length
      }
    });
  } catch (error) {
    console.error('Command center data error:', error);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
}

function getEditorCoverageStates(editor) {
  const states = [...(editor.assignedStates || [])];
  if (!states.length && editor.assignedState) states.push(editor.assignedState);
  if (editor.role === 'subeditor') {
    (editor.permissions?.managedStates || []).forEach(s => {
      if (s && !states.includes(s)) states.push(s);
    });
  }
  return states;
}

function normalizeSubEditorForView(se, stats = {}) {
  const approvalScope = se.permissions?.approvalScope || 'all';
  const managedStates = se.permissions?.managedStates || [];
  const managedDistricts = se.permissions?.managedDistricts || [];
  const managedReporterIds = se.permissions?.managedReporterIds || [];
  const postStates = se.assignedStates || [];
  const postDistricts = se.assignedDistricts || [];
  const allowedScopes = se.allowedScopes || [];

  let approvalLabel = 'All Reporters';
  let approvalDetail = 'Can review and approve news from every reporter in the system';
  if (approvalScope === 'geography' || approvalScope === 'locations') {
    approvalLabel = 'By Geography';
    approvalDetail = 'Can approve news only from reporters in assigned states/districts';
  } else if (approvalScope === 'reporters') {
    approvalLabel = 'Specific Reporters';
    approvalDetail = `Can approve news from ${managedReporterIds.length} selected reporter(s)`;
  }

  return {
    ...se,
    newsCount: stats.count || 0,
    approved: stats.approved || 0,
    rejected: stats.rejected || 0,
    approvalScope,
    approvalLabel,
    approvalDetail,
    managedStates,
    managedDistricts,
    managedReporterCount: managedReporterIds.length,
    postStates,
    postDistricts,
    allowedScopes,
    allowedScopesLabel: allowedScopes.length
      ? allowedScopes.join(', ')
      : 'Default (Local + State only)'
  };
}

function buildDateFilter(period, startDate, endDate) {
  const now = new Date();
  let from;

  switch (period) {
    case 'today':
      from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'week':
      from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'month':
      from = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'custom':
      if (startDate && endDate) {
        return { publishedAt: { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999Z') } };
      }
      from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    default:
      from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }
  return { publishedAt: { $gte: from } };
}

module.exports = { renderCommandCenter, getCommandCenterData };
