const News = require('../models/News');
const Location = require('../models/Location');
const Category = require('../models/Category');
const Admin = require('../models/Admin'); // Add Admin model for denormalization

const {
  normalizeNewsLanguage,
  buildNewsLanguageFilter,
  getLanguageViewData
} = require('../utils/newsLanguages');
const {
  getDisplayConfigForCode,
  refreshCache: refreshLanguageCache,
  getActiveLanguages,
  getEditorAllowedLanguages,
  isLanguageAllowedForEditor,
} = require('../services/languageRegistry');
const { normalizeNewsContent } = require('../utils/contentNormalize');
const path = require('path');
const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const axios = require('axios');
const sharp = require('sharp');
const { uploadToR2 } = require('../middleware/upload');
const { buildSubEditorAuthorFilter, getManagedReporterIds, buildSubEditorTabQuery, resolveSubEditorNewsTab, getAdminId, subEditorHasTeamScope, resolveReporterStateIncharge } = require('../utils/editorCoverageHelper');
const { TIER_DAILY_LIMIT, LIMIT_MESSAGE: DAILY_LIMIT_MESSAGE, isTierLimited, countReporterDailySubmissions } = require('../utils/dailyLimitService');
const { getActiveExtraAllowed } = require('../utils/accessOverrideService');

// Import the Notification and User models
const Notification = require('../models/Notification');
const User = require('../models/User');

// Import OneSignal service
const oneSignalService = require('../services/oneSignalService');

// Import cache middleware for cache invalidation
const { clearCache } = require('../middleware/cache');
const { redisClient, isRedisAvailable } = require('../config/redis');
const { runDuplicateCheckGateway } = require('../services/aiDuplicate/runDuplicateCheckGateway');
const {
  schedulePendingAfterCreate,
  schedulePendingAfterUpdate,
} = require('../services/aiDuplicate/semantic/scheduleNewsVectorPending');
const {
  scheduleMediaFingerprint,
} = require('../services/aiDuplicate/scheduleMediaFingerprint');
const {
  scheduleAiVerification,
} = require('../services/aiDuplicate/scheduleAiVerification');
const { generateContentHash } = require('../utils/similarityDetector');
const { normalizeDuplicateCheck } = require('../services/duplicateCheckService');

// Import Cloudflare R2 deletion utility
const { deleteFromR2 } = require('../config/cloudflare');

// Helper to strip color tags [c=#RRGGBB]...[/c] for length validation
const stripTags = (text) => {
  if (!text) return '';
  return text.toString()
    .replace(/\[c=#[0-9a-fA-F]{6}\]/gi, '')
    .replace(/\[\/c\]/gi, '')
    .replace(/\[b\]/gi, '')
    .replace(/\[\/b\]/gi, '');
};

async function getDisplayLimitsForLanguage(languageCode) {
  await refreshLanguageCache();
  return getDisplayConfigForCode(normalizeNewsLanguage(languageCode));
}

function getAuthorRoleLabel(authorAdmin) {
  if (!authorAdmin) return 'Reporter';

  if (authorAdmin.role === 'admin' || authorAdmin.role === 'superadmin') {
    return 'Admin';
  }

  if (authorAdmin.role === 'subeditor') {
    return authorAdmin.displayRole || 'Sub-Editor';
  }

  if (authorAdmin.role === 'editor') {
    return authorAdmin.displayRole || 'Reporter';
  }

  return 'Reporter';
}

function getActorRoleLabel(adminLike) {
  if (!adminLike) return 'System';

  if (adminLike.role === 'admin' || adminLike.role === 'superadmin') {
    return 'Admin';
  }

  if (adminLike.role === 'subeditor') {
    return adminLike.displayRole || 'Sub-Editor';
  }

  if (adminLike.role === 'editor') {
    return adminLike.displayRole || 'Reporter';
  }

  return adminLike.role || 'System';
}

function buildHistoryEntry(action, reqAdmin, details, metadata = {}) {
  return {
    action,
    performedById: reqAdmin?.id || reqAdmin?._id?.toString() || null,
    performedByName: reqAdmin?.username || reqAdmin?.name || 'System',
    performedByRole: getActorRoleLabel(reqAdmin),
    details,
    metadata,
    performedAt: new Date()
  };
}

// Render dashboard page
async function renderDashboard(req, res) {
  try {
    let totalNewsCount = 0;
    let activeNewsCount = 0;
    let inactiveNewsCount = 0;
    let pendingNewsCount = 0;
    let todaysNewsCount = 0;

    if (req.app.locals.isConnectedToMongoDB) {
      let newsList;

      let newsQuery = {};
      let isRestrictedSubEditor = false;
      let hasTeamScope = false;

      // Check user role and permissions
      if (req.admin.role === 'editor') {
        // Editors only see their own news
        newsQuery = { authorId: req.admin.id };
      } else if (req.admin.role === 'subeditor' && (!req.admin.permissions || !req.admin.permissions.canViewAllNews)) {
        isRestrictedSubEditor = true;
        const adminDoc = await Admin.findById(req.admin.id).lean();
        hasTeamScope = subEditorHasTeamScope(adminDoc);
        const subEditorQuery = await buildSubEditorAuthorFilter(Admin, adminDoc);
        if (subEditorQuery) {
          newsQuery = subEditorQuery;
        }
      }

      // Date boundary for "today" (computed once, used by the today-count query below).
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const todaysMatch = req.admin.role === 'editor'
        ? { authorId: req.admin.id, publishedAt: { $gte: today } }
        : { publishedAt: { $gte: today } };

      const viewsMatch = req.admin.role === 'editor'
        ? { authorId: req.admin.id }
        : {};

      // P3: total views is an unbounded sum over the (possibly whole) collection.
      // Serve it from a short-lived cache and only run the aggregation on a miss.
      const viewsCacheKey = req.admin.role === 'editor'
        ? `cache:dash:views:e:${req.admin.id}`
        : 'cache:dash:views:all';
      const computeTotalViews = async () => {
        if (isRedisAvailable()) {
          try {
            const cached = await redisClient.get(viewsCacheKey);
            if (cached !== null && cached !== undefined) return Number(cached);
          } catch (e) { /* fall through to compute */ }
        }
        const viewsAgg = await News.aggregate([
          { $match: viewsMatch },
          { $group: { _id: null, total: { $sum: { $ifNull: ['$views', 0] } } } }
        ]);
        const total = viewsAgg[0]?.total || 0;
        if (isRedisAvailable()) {
          redisClient.setEx(viewsCacheKey, 60, String(total)).catch(() => { /* non-fatal */ });
        }
        return total;
      };

      // P1: run every independent read concurrently instead of in a waterfall.
      // P2: fold the four status counts (total/active/inactive/pending) into one
      //     aggregation pass instead of four separate countDocuments calls.
      // P6: fetch the news list as lean plain objects.
      const [statusCounts, fetchedNews, categories, locations, todaysCount, totalViews] = await Promise.all([
        News.aggregate([
          { $match: newsQuery },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
              inactive: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 1, 0] } },
              pending: {
                $sum: {
                  $cond: [
                    { $and: [{ $eq: ['$isActive', false] }, { $ne: ['$rejectionStatus.isRejected', true] }] },
                    1,
                    0
                  ]
                }
              }
            }
          }
        ]),
        News.find(newsQuery).sort({ publishedAt: -1 }).limit(20).lean(),
        Category.find({ type: { $in: ['news', null] } }),
        Location.find(),
        News.countDocuments(todaysMatch),
        computeTotalViews()
      ]);

      newsList = fetchedNews;
      const counts = statusCounts[0] || {};
      totalNewsCount = counts.total || 0;
      activeNewsCount = counts.active || 0;
      inactiveNewsCount = counts.inactive || 0;
      pendingNewsCount = counts.pending || 0;
      todaysNewsCount = todaysCount;

      // Get all locations to create a map of name to code
      const locationMap = {};
      locations.forEach(location => {
        locationMap[location.name] = location.code;
      });

      const authorIds = [...new Set(newsList.map(news => news.authorId).filter(Boolean))];
      const authors = await Admin.find({ _id: { $in: authorIds } }).select('_id role displayRole').lean();
      const authorRoleMap = {};
      const authorSystemRoleMap = {};
      authors.forEach(author => {
        authorRoleMap[author._id.toString()] = getAuthorRoleLabel(author);
        authorSystemRoleMap[author._id.toString()] = author.role || 'editor';
      });

      // Add location codes to news items (news items are already lean plain objects)
      const newsListWithCodes = newsList.map(news => {
        return {
          ...news,
          locationCode: news.location ? locationMap[news.location] : null,
          authorRole: authorRoleMap[news.authorId] || 'Reporter',
          authorSystemRole: authorSystemRoleMap[news.authorId] || 'editor'
        };
      });

      res.render('index', {
        newsList: newsListWithCodes,
        categories,
        locations,
        todaysNewsCount,
        totalNewsCount,
        activeNewsCount,
        inactiveNewsCount,
        pendingNewsCount,
        totalViews,
        admin: req.admin,
        isRestrictedSubEditor,
        hasTeamScope
      });
    } else {
      // Use in-memory storage
      const newsData = req.app.locals.newsData || [];
      const categoryData = req.app.locals.categoryData || [];
      const locationData = req.app.locals.locationData || [];

      // Calculate counts for in-memory data
      totalNewsCount = newsData.length;
      activeNewsCount = newsData.filter(news => news.isActive !== false).length;
      inactiveNewsCount = newsData.filter(news => news.isActive === false).length;
      pendingNewsCount = newsData.filter(news =>
        news.isActive === false && !(news.rejectionStatus && news.rejectionStatus.isRejected)
      ).length;

      // Calculate today's news count for in-memory data
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      todaysNewsCount = newsData.filter(news => {
        const newsDate = new Date(news.publishedAt);
        newsDate.setHours(0, 0, 0, 0);
        return newsDate.getTime() === today.getTime();
      }).length;

      // Get all locations to create a map of name to code (for in-memory storage)
      const locationMap = {};
      locationData.forEach(location => {
        locationMap[location.name] = location.code;
      });

      // Add location codes to news items (for in-memory storage)
      // Limit to latest 12 news items
      const limitedNewsData = newsData
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
        .slice(0, 12);

      const newsListWithCodes = limitedNewsData.map(news => {
        return {
          ...news,
          locationCode: news.location ? locationMap[news.location] : null,
          authorRole: news.authorRole || 'Reporter',
          authorSystemRole: news.authorSystemRole || 'editor'
        };
      });

      const totalViews = newsData.reduce((sum, news) => sum + (news.views || 0), 0);

      res.render('index', {
        newsList: newsListWithCodes,
        categories: categoryData,
        locations: locationData,
        todaysNewsCount,
        totalNewsCount,
        activeNewsCount,
        inactiveNewsCount,
        pendingNewsCount,
        totalViews,
        admin: req.admin
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error fetching news' });
  }
}

// Render news list page with filtering capabilities
async function renderNewsListPage(req, res) {
  console.log('renderNewsListPage called'); // Debug log
  try {
    // Pagination settings
    const page = parseInt(req.query.page) || 1;
    const limit = 21; // 21 news per page for fast loading
    const skip = (page - 1) * limit;
    const searchQuery = req.query.search || '';
    const selectedAuthorId = req.query.authorId || '';
    const fromDate = req.query.fromDate || '';
    const toDate = req.query.toDate || '';
    const selectedLanguage = req.query.language || '';
    const languageViewData = await getLanguageViewData();

    if (req.app.locals.isConnectedToMongoDB) {
      console.log('Using MongoDB'); // Debug log
      let newsList;
      let locations;
      let selectedLocation = req.query.location || '';
      let selectedStatus = req.query.status || '';

      // Build query based on filters
      let query = {};

      // Search filter - search in title (case-insensitive)
      if (searchQuery) {
        query.title = { $regex: searchQuery, $options: 'i' };
      }

      // Location filter
      if (selectedLocation) {
        query.location = selectedLocation;
      }

      // Status filter
      if (selectedStatus === 'active') {
        query.isActive = true;
      } else if (selectedStatus === 'inactive') {
        query.isActive = false;
        query['rejectionStatus.isRejected'] = { $ne: true };
        query.isDeactivated = true;
      } else if (selectedStatus === 'pending') {
        query.isActive = false;
        query['rejectionStatus.isRejected'] = { $ne: true };
        query.isDeactivated = { $ne: true };
      } else if (selectedStatus === 'rejected') {
        query['rejectionStatus.isRejected'] = true;
      }

      // Date range filter
      if (fromDate || toDate) {
        query.publishedAt = {};
        if (fromDate) {
          query.publishedAt.$gte = new Date(fromDate);
        }
        if (toDate) {
          // Add 1 day to include the entire toDate
          const endDate = new Date(toDate);
          endDate.setDate(endDate.getDate() + 1);
          query.publishedAt.$lt = endDate;
        }
      }

      let isRestrictedSubEditor = false;
      let currentTab = req.query.tab || 'my-list';
      let subEditorTabCounts = null;
      let hasTeamScope = false;
      const isImpersonating = !!(req.isImpersonating || res.locals?.isImpersonating);
      const scopeOptions = isImpersonating ? { ignoreCanViewAllNews: true } : {};

      // Check user role and permissions
      if (req.admin.role === 'editor') {
        // Editors only see their own news
        query.authorId = getAdminId(req.admin);
      } else if (req.admin.role === 'subeditor' && (isImpersonating || !req.admin.permissions?.canViewAllNews)) {
        isRestrictedSubEditor = true;
        const adminDoc = await Admin.findById(getAdminId(req.admin)).lean();
        const adminId = getAdminId(adminDoc || req.admin);
        hasTeamScope = subEditorHasTeamScope(adminDoc);
        const reporterIds = await getManagedReporterIds(Admin, adminDoc, scopeOptions);

        currentTab = await resolveSubEditorNewsTab(Admin, News, adminDoc, req.query.tab, scopeOptions);
        if (!hasTeamScope && currentTab === 'team-list') {
          currentTab = 'my-list';
        }

        if (selectedAuthorId) {
          const allowed = reporterIds === null ||
            reporterIds.includes(selectedAuthorId) ||
            selectedAuthorId === adminId;
          const authorClause = allowed
            ? { authorId: selectedAuthorId }
            : { authorId: '__not_allowed__' };
          query = Object.keys(query).length === 0
            ? authorClause
            : { $and: [query, authorClause] };
        } else {
          const tabQuery = buildSubEditorTabQuery(currentTab, adminId, reporterIds, scopeOptions);
          query = Object.keys(query).length === 0
            ? tabQuery
            : { $and: [query, tabQuery] };
        }

        const [myListCount, teamListCount] = await Promise.all([
          News.countDocuments({ authorId: adminId }),
          reporterIds === null
            ? News.countDocuments({ authorId: { $ne: adminId } })
            : (reporterIds.length
              ? News.countDocuments({ authorId: { $in: reporterIds.filter(id => id !== adminId) } })
              : Promise.resolve(0))
        ]);
        subEditorTabCounts = { myList: myListCount, teamList: teamListCount };
      } else if (selectedAuthorId) {
        query.authorId = selectedAuthorId;
      }

      if (selectedLanguage) {
        const languageFilter = buildNewsLanguageFilter(selectedLanguage);
        query = Object.keys(query).length === 0
          ? languageFilter
          : { $and: [query, languageFilter] };
      }

      // P1: count, page fetch and locations are independent — run them concurrently.
      // P6: fetch the page of news as lean plain objects.
      const [totalNews, fetchedNews, fetchedLocations] = await Promise.all([
        News.countDocuments(query),
        News.find(query)
          .sort({ publishedAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Location.find()
      ]);

      const totalPages = Math.ceil(totalNews / limit);
      newsList = fetchedNews;
      locations = fetchedLocations;

      // Get all locations to create a map of name to code
      const locationMap = {};
      locations.forEach(location => {
        locationMap[location.name] = location.code;
      });

      const authorIds = [...new Set(newsList.map(news => news.authorId).filter(Boolean))];
      const authors = await Admin.find({ _id: { $in: authorIds } }).select('_id role displayRole name email mobileNumber constituency').lean();
      const authorRoleMap = {};
      const authorSystemRoleMap = {};
      const authorDetailsMap = {};
      authors.forEach(author => {
        authorRoleMap[author._id.toString()] = getAuthorRoleLabel(author);
        authorSystemRoleMap[author._id.toString()] = author.role || 'editor';
        authorDetailsMap[author._id.toString()] = author;
      });

      // Add location codes to news items (news items are already lean plain objects)
      const newsListWithCodes = newsList.map(news => {
        return {
          ...news,
          locationCode: news.location ? locationMap[news.location] : null,
          authorRole: authorRoleMap[news.authorId] || 'Reporter',
          authorSystemRole: authorSystemRoleMap[news.authorId] || 'editor',
          authorDetails: authorDetailsMap[news.authorId] || null
        };
      });

      console.log('Rendering news-list with', newsListWithCodes.length, 'news items, page', page, 'of', totalPages); // Debug log
      res.render('news-list', {
        newsList: newsListWithCodes,
        locations,
        selectedLocation,
        selectedStatus,
        selectedLanguage,
        selectedAuthorId,
        searchQuery,
        fromDate,
        toDate,
        ...languageViewData,
        admin: req.admin,
        activePage: req.activePageOverride || 'news-list',
        pagination: {
          currentPage: page,
          totalPages,
          totalNews,
          limit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        },
        isRestrictedSubEditor,
        currentTab,
        subEditorTabCounts,
        hasTeamScope
      });
    } else {
      console.log('Using in-memory storage'); // Debug log
      // Use in-memory storage
      const newsData = req.app.locals.newsData || [];
      const locationData = req.app.locals.locationData || [];
      const selectedLocation = req.query.location || '';
      const selectedStatus = req.query.status || '';

      // Filter news by location if specified
      let filteredNewsData = [...newsData];

      // Search filter - search in title (case-insensitive)
      if (searchQuery) {
        filteredNewsData = filteredNewsData.filter(news =>
          news.title.toLowerCase().includes(searchQuery.toLowerCase())
        );
      }

      // Location filter
      if (selectedLocation) {
        filteredNewsData = filteredNewsData.filter(news => news.location === selectedLocation);
      }

      // Status filter
      if (selectedStatus === 'active') {
        filteredNewsData = filteredNewsData.filter(news => news.isActive !== false);
      } else if (selectedStatus === 'inactive') {
        filteredNewsData = filteredNewsData.filter(news =>
          news.isActive === false && !(news.rejectionStatus && news.rejectionStatus.isRejected) && news.isDeactivated
        );
      } else if (selectedStatus === 'pending') {
        filteredNewsData = filteredNewsData.filter(news =>
          news.isActive === false && !(news.rejectionStatus && news.rejectionStatus.isRejected) && !news.isDeactivated
        );
      } else if (selectedStatus === 'rejected') {
        filteredNewsData = filteredNewsData.filter(news =>
          news.rejectionStatus && news.rejectionStatus.isRejected
        );
      }

      // Date range filter
      if (fromDate) {
        const fromDateTime = new Date(fromDate);
        filteredNewsData = filteredNewsData.filter(news => new Date(news.publishedAt) >= fromDateTime);
      }
      if (toDate) {
        const toDateTime = new Date(toDate);
        toDateTime.setDate(toDateTime.getDate() + 1); // Include entire toDate
        filteredNewsData = filteredNewsData.filter(news => new Date(news.publishedAt) < toDateTime);
      }

      // Check user role
      if (req.admin.role === 'editor') {
        // Editors only see their own news
        filteredNewsData = filteredNewsData.filter(news => news.authorId === req.admin.id);
      } else if (selectedAuthorId) {
        filteredNewsData = filteredNewsData.filter(news => news.authorId === selectedAuthorId);
      }

      if (selectedLanguage) {
        const normalizedLanguage = normalizeNewsLanguage(selectedLanguage);
        filteredNewsData = filteredNewsData.filter(news =>
          normalizeNewsLanguage(news.language) === normalizedLanguage
        );
      }

      // Sort by published date
      filteredNewsData.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

      // Get total count for pagination
      const totalNews = filteredNewsData.length;
      const totalPages = Math.ceil(totalNews / limit);

      // Apply pagination
      const paginatedNews = filteredNewsData.slice(skip, skip + limit);

      // Get all locations to create a map of name to code (for in-memory storage)
      const locationMap = {};
      locationData.forEach(location => {
        locationMap[location.name] = location.code;
      });

      // Add location codes to news items (for in-memory storage)
      const newsListWithCodes = paginatedNews.map(news => {
        return {
          ...news,
          locationCode: news.location ? locationMap[news.location] : null,
          authorRole: news.authorRole || 'Reporter',
          authorSystemRole: news.authorSystemRole || 'editor'
        };
      });

      console.log('Rendering news-list with', newsListWithCodes.length, 'news items, page', page, 'of', totalPages); // Debug log
      res.render('news-list', {
        newsList: newsListWithCodes,
        locations: locationData,
        selectedLocation,
        selectedStatus,
        selectedLanguage,
        selectedAuthorId,
        searchQuery,
        fromDate,
        toDate,
        ...languageViewData,
        admin: req.admin,
        activePage: req.activePageOverride || 'news-list',
        pagination: {
          currentPage: page,
          totalPages,
          totalNews,
          limit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
      });
    }
  } catch (error) {
    console.error('Error fetching news list:', error);
    res.status(500).json({ error: 'Error fetching news list' });
  }
}

// Get all news (API endpoint)
async function getAllNews(req, res) {
  try {
    let newsList;

    // Check user role
    if (req.admin.role === 'editor') {
      // Editors only see their own news
      newsList = await News.find({ authorId: req.admin.id }).sort({ publishedAt: -1 });
    } else {
      // Admins and superadmins see all news
      newsList = await News.find().sort({ publishedAt: -1 });
    }

    // Get all locations to create a map of name to code
    const locations = await Location.find({}, 'name code');
    const locationMap = {};
    locations.forEach(location => {
      locationMap[location.name] = location.code;
    });

    // Add location codes to news items
    const newsListWithCodes = newsList.map(news => {
      return {
        ...news.toObject(),
        locationCode: news.location ? locationMap[news.location] : null
      };
    });

    // Render the dashboard page with news data
    res.render('index', { newsList: newsListWithCodes });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching news' });
  }
}

// Get news by ID (editors can only access their own news)
async function getNewsById(req, res) {
  try {
    const news = await News.findById(req.params.id);
    if (!news) {
      return res.status(404).json({ error: 'News not found' });
    }

    // Check if editor is trying to access someone else's news
    if (req.admin.role === 'editor' && news.authorId !== req.admin.id) {
      return res.status(403).json({ error: 'Access denied. You can only view your own news.' });
    }

    const author = news.authorId
      ? await Admin.findById(news.authorId).select('role displayRole').lean()
      : null;

    const payload = news.toObject();
    // Reporters do not need the frozen admin compare snapshot
    if (
      req.admin.role === 'editor' &&
      payload.revisionStatus &&
      payload.revisionStatus.revisionSnapshot
    ) {
      delete payload.revisionStatus.revisionSnapshot;
    }

    res.json({
      ...payload,
      authorRole: getAuthorRoleLabel(author),
      authorSystemRole: author?.role || 'editor'
    });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching news' });
  }
}

// Render add news page
async function renderAddNewsPage(req, res) {
  try {
    const adminDoc = await Admin.findById(req.admin.id)
      .select('workingLanguage assignedStates assignedDistricts allowedScopes allowedLanguages role')
      .lean();
    const languageViewData = await getLanguageViewData();
    const activeLanguages = getActiveLanguages();
    const editorAllowedLanguages = getEditorAllowedLanguages(adminDoc, activeLanguages);
    const unrestrictedLanguages = adminDoc?.role === 'admin' || adminDoc?.role === 'superadmin';
    const { getDisplayConfigMap } = require('../services/languageRegistry');
    await refreshLanguageCache();
    res.render('add-news', {
      admin: req.admin,
      editorAssignedStates: adminDoc?.assignedStates || [],
      editorAssignedDistricts: adminDoc?.assignedDistricts || [],
      editorAllowedScopes: adminDoc?.allowedScopes || [],
      editorAllowedLanguages: unrestrictedLanguages ? [] : editorAllowedLanguages,
      defaultLanguage: editorAllowedLanguages[0] || adminDoc?.workingLanguage || languageViewData.defaultLanguage,
      displayConfigByLanguage: getDisplayConfigMap(),
      ...languageViewData
    });
  } catch (error) {
    res.status(500).json({ error: 'Error loading add news page' });
  }
}

// Render edit news page
async function renderEditNewsPage(req, res) {
  try {
    const news = await News.findById(req.params.id);
    if (!news) {
      return res.status(404).json({ error: 'News not found' });
    }

    const isSuperAdmin = req.admin.role === 'superadmin';
    const hasEditPerm = req.admin.role === 'subeditor' && req.admin.permissions && req.admin.permissions.canEditNews;
    const canEditAny = isSuperAdmin || req.admin.role === 'admin' || hasEditPerm;

    // Check if editor is trying to edit someone else's news
    if (!canEditAny && news.authorId !== req.admin.id) {
      return res.status(403).json({ error: 'Access denied. You can only edit your own news.' });
    }

    // Check if news is rejected and user is not superadmin/assigned subeditor
    if (news.rejectionStatus && news.rejectionStatus.isRejected && !isSuperAdmin && !hasEditPerm) {
      return res.status(403).json({ error: 'Access denied. Rejected news can only be edited by authorized admins.' });
    }

    // Reporter may open edit page only while Needs Revision
    if (!canEditAny) {
      const needsRevision =
        news.revisionStatus && news.revisionStatus.needsRevision === true;
      if (!needsRevision) {
        return res.status(403).json({
          error:
            'Access denied. Pending news is locked. You can edit only after an admin sends it back for revision.',
        });
      }
    }

    const adminDoc = await Admin.findById(req.admin.id)
      .select('workingLanguage assignedStates assignedDistricts allowedScopes allowedLanguages role')
      .lean();
    const languageViewData = await getLanguageViewData();
    const activeLanguages = getActiveLanguages();
    const editorAllowedLanguages = getEditorAllowedLanguages(adminDoc, activeLanguages);
    const unrestrictedLanguages = adminDoc?.role === 'admin' || adminDoc?.role === 'superadmin';
    const { getDisplayConfigMap } = require('../services/languageRegistry');
    await refreshLanguageCache();
    res.render('add-news', {
      news,
      admin: req.admin,
      editorAssignedStates: adminDoc?.assignedStates || [],
      editorAssignedDistricts: adminDoc?.assignedDistricts || [],
      editorAllowedScopes: adminDoc?.allowedScopes || [],
      editorAllowedLanguages: unrestrictedLanguages ? [] : editorAllowedLanguages,
      defaultLanguage: news.language || editorAllowedLanguages[0] || adminDoc?.workingLanguage || languageViewData.defaultLanguage,
      displayConfigByLanguage: getDisplayConfigMap(),
      source: req.query.source || '',
      ...languageViewData
    });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching news for editing' });
  }
}

/**
 * Sub editor news posting area check:
 * - state / national / international scope: location restriction ledu (anni states allowed)
 * - district scope: assignedDistricts set chesi unte, aa districts + vaati constituencies ki matrame post cheyagalru
 * Returns error message string, or null if allowed.
 */
async function validatePostingArea(reqAdmin, scope, location) {
  if (!reqAdmin || reqAdmin.role !== 'subeditor') return null;

  const adminDoc = await Admin.findById(reqAdmin.id)
    .select('assignedDistricts allowedScopes permissions.managedStates').lean();

  const allowedScopes = (adminDoc?.allowedScopes || []).filter(Boolean);
  if (allowedScopes.length && !allowedScopes.includes(scope)) {
    return `You are not allowed to post ${scope} news.`;
  }

  // Per-state guard: a sub-editor who is district-restricted in a given state (has
  // assignedDistricts there) must not post STATE-level news for THAT state — they must
  // post under their assigned districts instead. It activates ONLY when the sub-editor
  // has an explicit managed-state approval scope (permissions.managedStates non-empty),
  // which is the mixed per-state config (e.g. district-only in UP, state-level elsewhere).
  // State-level sub-editors (managedStates empty) are intentionally unaffected, so no
  // existing user's behaviour changes. Other states (where they have no assignedDistricts)
  // remain state-level allowed.
  if (scope === 'state') {
    const managedStates = (adminDoc?.permissions?.managedStates || []).filter(Boolean);
    const stateDistricts = (adminDoc?.assignedDistricts || []).filter(Boolean);
    const stateName = (location || '').trim();
    if (managedStates.length && stateDistricts.length && stateName) {
      const restrictedHere = await Location.exists({
        locationType: 'district', parentName: stateName, name: { $in: stateDistricts }
      });
      if (restrictedHere) {
        return `You are restricted to district-level posting in ${stateName}. Please post under your assigned districts.`;
      }
    }
    return null;
  }

  if (scope !== 'district') return null;

  const districts = (adminDoc?.assignedDistricts || []).filter(Boolean);
  if (!districts.length) return null; // posting area restriction set cheyyaledu

  const loc = (location || '').trim();
  if (!loc) return 'Please select a district for district news.';
  if (districts.includes(loc)) return null;

  const constituency = await Location.findOne({ name: loc, locationType: 'constituency' })
    .select('parentName').lean();
  if (constituency && districts.includes(constituency.parentName)) return null;

  return `You can post district news only for your assigned districts (${districts.join(', ')}) and their constituencies.`;
}

// Create new news (include author information)
async function createNews(req, res) {
  try {
    const authorDetails = await Admin.findById(req.admin.id).select('profileImage constituency workingLanguage allowedLanguages role permissions reporterTier assignedStates assignedState assignedDistricts assignedConstituencies assignedLocations location');
    const articleLanguage = normalizeNewsLanguage(req.body.language || authorDetails?.workingLanguage);

    // Replay protection — same Idempotency-Key returns the first saved article (no second insert)
    const rawIdempotencyKey = String(
      req.get('Idempotency-Key') || req.get('X-Idempotency-Key') || req.body?.clientIdempotencyKey || ''
    ).trim();
    const idempotencyKey = rawIdempotencyKey.slice(0, 128);
    if (idempotencyKey) {
      const existingByKey = await News.findOne({
        authorId: String(req.admin.id),
        clientIdempotencyKey: idempotencyKey,
      });
      if (existingByKey) {
        return res.status(200).json(existingByKey);
      }
    }

    // ── Tiered reporter daily submission cap (P2) ─────────────────────────────
    // Applies ONLY to reporterTier stringer | district_incharge. reporterTier=null
    // (every existing reporter) skips this entirely → 100% unchanged behaviour.
    // Runs AFTER the idempotency short-circuit (replays never consume a slot) and
    // BEFORE any News creation/save. Server-authoritative; keyed to the session
    // identity only (never a client-supplied id).
    if (authorDetails && isTierLimited(authorDetails.reporterTier)) {
      const submittedToday = await countReporterDailySubmissions(req.admin.id);
      // P4 — an active, today-only (IST) override raises the cap to 10 + extra.
      // 0 when none (the common case) → P2 behaviour unchanged.
      const extraAllowed = await getActiveExtraAllowed(req.admin.id);
      if (submittedToday >= TIER_DAILY_LIMIT + extraAllowed) {
        let stateInCharge = null;
        try {
          stateInCharge = await resolveReporterStateIncharge(Admin, authorDetails);
        } catch (_) { stateInCharge = null; }
        return res.status(429).json({
          error: DAILY_LIMIT_MESSAGE,
          limitReached: true,
          dailyLimit: TIER_DAILY_LIMIT,
          stateInCharge, // { name, mobileNumber } | null
        });
      }
    }

    if (authorDetails && authorDetails.role !== 'admin' && authorDetails.role !== 'superadmin') {
      if (!isLanguageAllowedForEditor(authorDetails, articleLanguage)) {
        return res.status(403).json({ error: 'You are not allowed to post news in this language.' });
      }
    }

    const postingAreaError = await validatePostingArea(req.admin, req.body.scope || 'state', req.body.location);
    if (postingAreaError) {
      return res.status(403).json({ error: postingAreaError });
    }

    const limits = await getDisplayLimitsForLanguage(articleLanguage);

    if (req.admin.permissions?.requiresSourceLink) {
      if (!req.body.sourceLink || req.body.sourceLink.trim() === '') {
        return res.status(400).json({ error: 'Source Link is mandatory' });
      }
    }

    // Validation (ignoring color tags for limit)
    if (req.body.title && stripTags(req.body.title).length > limits.titleMax) {
      return res.status(400).json({ error: `Title cannot exceed ${limits.titleMax} characters` });
    }
    if (req.body.content && stripTags(req.body.content).length > limits.contentMax) {
      return res.status(400).json({ error: `Content cannot exceed ${limits.contentMax} characters` });
    }
    if (req.admin.role === 'subeditor' && req.body.content && stripTags(req.body.content).length < (limits.contentMin || 0)) {
      return res.status(400).json({ error: `Content must be at least ${limits.contentMin} characters for Sub Editors` });
    }

    if (req.body.content) {
      req.body.content = normalizeNewsContent(req.body.content);
    }
    if (req.body.title) {
      req.body.title = normalizeNewsContent(req.body.title);
    }

    // Add author information and explicit timestamp to the news
    const newsData = {
      ...req.body,
      author: req.admin.username,
      authorId: req.admin.id,
      authorProfileImage: authorDetails?.profileImage || null,
      authorConstituency: authorDetails?.constituency || null,
      language: articleLanguage,
      scope: req.body.scope || 'state',
      actionHistory: [
        buildHistoryEntry('created', req.admin, 'News article created', {
          title: req.body.title,
          category: req.body.category,
          location: req.body.location || null,
          scope: req.body.scope || 'state'
        })
      ],
      publishedAt: new Date() // Explicitly set the timestamp
    };

    // Role-based isActive:
    // Reporter (editor role) → isActive: false → goes to Pending News (needs admin approval)
    // Admin / Sub-Editor / SuperAdmin → isActive: true → directly published to News List

    // Role-based isActive:
    // Admin / SuperAdmin → isActive: true → directly published (no AI gate)
    // Sub-Editor → isActive: false, aiStatus: 'processing' → AI verifies async → auto-publish
    // Reporter (editor role) → isActive: false → Pending News (human approval)

    const directPublishRoles = ['admin', 'superadmin'];
    const aiGateRoles = ['subeditor'];

    // Super admin can disable the News AI check per sub-editor (permissions.aiCheckEnabled).
    // When disabled, this sub-editor's news skips the AI gate and publishes directly.
    // Default (undefined) = enabled, preserving existing behaviour.
    const aiCheckEnabled = authorDetails?.permissions?.aiCheckEnabled !== false;
    const useAiGate = aiGateRoles.includes(req.admin.role) && aiCheckEnabled;

    if (directPublishRoles.includes(req.admin.role)) {
      newsData.isActive = true;   // → Direct Publish (No Pending)
      newsData.aiStatus = 'none';
    } else if (useAiGate) {
      newsData.isActive = false;  // → Pending until AI verifies
      newsData.aiStatus = 'processing';
    } else if (aiGateRoles.includes(req.admin.role)) {
      // Sub-editor with AI check turned OFF by super admin → publish directly (no AI gate).
      newsData.isActive = true;
      newsData.aiStatus = 'none';
    } else {
      newsData.isActive = false;  // → Pending News (Reporter/Editor approval needed)
      newsData.aiStatus = 'none';
    }

    // Client-only fields — never persist on News
    delete newsData.precomputedDuplicate;
    delete newsData.ignoreLanguageWarning;
    delete newsData.clientIdempotencyKey;

    if (idempotencyKey) {
      newsData.clientIdempotencyKey = idempotencyKey;
    }

    // Handle media fields for backward compatibility
    if (req.body.mediaUrl) {
      newsData.mediaUrl = req.body.mediaUrl;
      newsData.mediaType = req.body.mediaType;
      // Add thumbnailUrl if provided
      if (req.body.thumbnailUrl) {
        newsData.thumbnailUrl = req.body.thumbnailUrl;
      }
      // For backward compatibility, also set imageUrl if it's an image
      if (req.body.mediaType === 'image') {
        newsData.imageUrl = req.body.mediaUrl;
      }
    } else if (req.body.imageUrl) {
      // For backward compatibility with existing code that still uses imageUrl
      newsData.mediaUrl = req.body.imageUrl;
      newsData.mediaType = 'image';
      newsData.imageUrl = req.body.imageUrl;
      // For images, use the same URL for thumbnail
      newsData.thumbnailUrl = req.body.imageUrl;
    }

    const news = new News(newsData);

    // Local content hash — AI duplicate check runs asynchronously after save.
    const contentHash = generateContentHash(news.title, news.content);
    const duplicateCheck = normalizeDuplicateCheck(null);

    news.contentHash = contentHash;
    news.duplicateCheck = duplicateCheck;

    try {
      await news.save();
    } catch (saveError) {
      // Parallel double-submit race: unique index won — return the winner
      if (saveError && saveError.code === 11000 && idempotencyKey) {
        const raced = await News.findOne({
          authorId: String(req.admin.id),
          clientIdempotencyKey: idempotencyKey,
        });
        if (raced) {
          return res.status(200).json(raced);
        }
      }
      throw saveError;
    }

    // Phase-4.2 — fire-and-forget PENDING vector (worker embeds async). Never blocks publish.
    schedulePendingAfterCreate(news);
    // Media pHash/dHash/OpenCLIP + FAISS index (async). Detect reuses caches.
    scheduleMediaFingerprint(news);

    // Sub Editor async AI verification — auto-publishes on clean, flags on duplicate.
    // Skipped when super admin has disabled the AI check for this sub-editor.
    if (useAiGate) {
      const io = req.app.locals.io;
      scheduleAiVerification(news, io);
    }

    // Send WebSocket notifications based on role
    const io = req.app.locals.io;
    const connectedClients = req.app.locals.connectedClients;

    if (io) {
      // Prepare notification data
      const notificationData = {
        id: news._id,
        title: news.title,
        content: news.content,
        category: news.category,
        location: news.location,
        publishedAt: news.publishedAt,
        author: news.author,
        authorId: news.authorId,
        mediaType: news.mediaType,
        mediaUrl: news.mediaUrl,
        thumbnailUrl: news.thumbnailUrl,
        imageUrl: news.imageUrl || news.mediaUrl,
        imageUrls: news.imageUrls || [],
        language: news.language,
        constituency: news.authorConstituency || authorDetails?.constituency || null,
      };

      // ✅ Direct Publish Roles: admin, superadmin (subeditor normally goes through AI gate).
      // A sub-editor with the AI check disabled also publishes directly, so emit "published".
      const directPublishRolesWs = ['admin', 'superadmin'];
      const isDirectPublish =
        directPublishRolesWs.includes(req.admin.role) ||
        (aiGateRoles.includes(req.admin.role) && !useAiGate);

      if (isDirectPublish) {
        const { emitPublished } = require('../services/realtime/workflowEmit');
        emitPublished(io, notificationData);
      } else {
        const { emitNewPendingNews } = require('../services/realtime/workflowEmit');
        emitNewPendingNews(io, notificationData);
      }
    } else {
      console.log('⚠️ WebSocket io not available');
    }

    // 🔄 Clear news cache after creating new news
    await clearCache('cache:/api/public/news*');
    await clearCache('cache:/api/public/locations*');

    // Send JSON response for API calls
    const responsePayload = news.toObject();
    if (duplicateCheck.isDuplicate || duplicateCheck.isSuspicious) {
      responsePayload.duplicateWarning = {
        isDuplicate: duplicateCheck.isDuplicate,
        isSuspicious: duplicateCheck.isSuspicious,
        score: duplicateCheck.score,
        matchCount: duplicateCheck.matchCount,
        message: duplicateCheck.isDuplicate
          ? 'Duplicate content detected. This article closely matches existing news.'
          : 'Similar content detected. Please review before approval.'
      };
    }

    res.status(201).json(responsePayload);
  } catch (error) {
    console.error('Error creating news:', error);
    res.status(400).json({ error: 'Error creating news' });
  }
}

// Update news (editors can only update their own news)
async function updateNews(req, res) {
  try {
    // First, find the news to check ownership
    const existingNews = await News.findById(req.params.id);
    if (!existingNews) {
      return res.status(404).json({ error: 'News not found' });
    }

    const isSuperAdmin = req.admin.role === 'superadmin';
    const hasEditPerm = req.admin.role === 'subeditor' && req.admin.permissions && req.admin.permissions.canEditNews;
    const canEditAny = isSuperAdmin || req.admin.role === 'admin' || hasEditPerm;

    // Check if editor is trying to update someone else's news
    if (!canEditAny && existingNews.authorId !== req.admin.id) {
      return res.status(403).json({ error: 'Access denied. You can only update your own news.' });
    }

    // Reporter updates must go through Resubmit only (single official revision path)
    if (!canEditAny) {
      return res.status(403).json({
        error:
          'Access denied. Use Resubmit to submit revisions. Direct updates are not allowed for reporters.',
      });
    }

    // Check if news is rejected and user is not superadmin/assigned subeditor
    if (existingNews.rejectionStatus && existingNews.rejectionStatus.isRejected && !isSuperAdmin && !hasEditPerm) {
      return res.status(403).json({ error: 'Access denied. Rejected news can only be edited by authorized admins.' });
    }

    if (req.admin.permissions?.requiresSourceLink) {
      if (!req.body.sourceLink || req.body.sourceLink.trim() === '') {
        return res.status(400).json({ error: 'Source Link is mandatory' });
      }
    }

    // Validation (ignoring color tags for limit)
    const authorForLang = await Admin.findById(req.admin.id).select('workingLanguage allowedLanguages role');
    const articleLanguage = normalizeNewsLanguage(req.body.language || existingNews.language);

    if (authorForLang && authorForLang.role !== 'admin' && authorForLang.role !== 'superadmin') {
      if (!isLanguageAllowedForEditor(authorForLang, articleLanguage)) {
        return res.status(403).json({ error: 'You are not allowed to post news in this language.' });
      }
    }

    const effectiveScope = req.body.scope !== undefined ? req.body.scope : (existingNews.scope || 'state');
    const effectiveLocation = req.body.location !== undefined ? req.body.location : existingNews.location;
    const postingAreaError = await validatePostingArea(req.admin, effectiveScope, effectiveLocation);
    if (postingAreaError) {
      return res.status(403).json({ error: postingAreaError });
    }

    const limits = await getDisplayLimitsForLanguage(articleLanguage);
    if (req.body.title && stripTags(req.body.title).length > limits.titleMax) {
      return res.status(400).json({ error: `Title cannot exceed ${limits.titleMax} characters` });
    }
    if (req.body.content && stripTags(req.body.content).length > limits.contentMax) {
      return res.status(400).json({ error: `Content cannot exceed ${limits.contentMax} characters` });
    }
    if (req.admin.role === 'subeditor' && req.body.content && stripTags(req.body.content).length < (limits.contentMin || 0)) {
      return res.status(400).json({ error: `Content must be at least ${limits.contentMin} characters for Sub Editors` });
    }

    if (req.body.content) {
      req.body.content = normalizeNewsContent(req.body.content);
    }
    if (req.body.title) {
      req.body.title = normalizeNewsContent(req.body.title);
    }

    // Fetch author details for denormalization
    const authorDetails = await Admin.findById(req.admin.id).select('profileImage constituency');

    // Add author information to the update (in case it's missing)
    // Note: We don't update the publishedAt timestamp when editing news
    const changedFieldKeys = Object.keys(req.body || {}).filter(key => typeof req.body[key] !== 'undefined');
    const updatedHistory = Array.isArray(existingNews.actionHistory) ? [...existingNews.actionHistory] : [];
    updatedHistory.push(
      buildHistoryEntry(
        'updated',
        req.admin,
        changedFieldKeys.length > 0
          ? `News article updated (${changedFieldKeys.join(', ')})`
          : 'News article updated',
        { changedFields: changedFieldKeys }
      )
    );

    const newsData = {
      ...req.body,
      author: existingNews.author || req.admin.username,
      authorId: existingNews.authorId || req.admin.id,
      authorProfileImage: existingNews.authorProfileImage || authorDetails?.profileImage || null,
      authorConstituency: existingNews.authorConstituency || authorDetails?.constituency || null,
      actionHistory: updatedHistory,
    };

    if (req.body.language !== undefined) {
      newsData.language = normalizeNewsLanguage(req.body.language);
    }

    // Handle media fields for backward compatibility
    if (req.body.mediaUrl) {
      newsData.mediaUrl = req.body.mediaUrl;
      newsData.mediaType = req.body.mediaType;
      // Add thumbnailUrl if provided
      if (req.body.thumbnailUrl) {
        newsData.thumbnailUrl = req.body.thumbnailUrl;
      }
      // For backward compatibility, also set imageUrl if it's an image
      if (req.body.mediaType === 'image') {
        newsData.imageUrl = req.body.mediaUrl;
      }
    } else if (req.body.imageUrl) {
      // For backward compatibility with existing code that still uses imageUrl
      newsData.mediaUrl = req.body.imageUrl;
      newsData.mediaType = 'image';
      newsData.imageUrl = req.body.imageUrl;
      // For images, use the same URL for thumbnail
      newsData.thumbnailUrl = req.body.imageUrl;
    }

    // If media is being updated, delete the old media from Cloudflare R2
    if (req.body.mediaUrl && existingNews.mediaUrl && req.body.mediaUrl !== existingNews.mediaUrl) {
      await deleteFromR2(existingNews.mediaUrl);
      if (existingNews.mediaType === 'video' && existingNews.thumbnailUrl && existingNews.thumbnailUrl !== existingNews.mediaUrl) {
        await deleteFromR2(existingNews.thumbnailUrl);
      }
    }

    const news = await News.findByIdAndUpdate(req.params.id, newsData, { new: true });

    const titleChanged = typeof req.body.title !== 'undefined';
    const contentChanged = typeof req.body.content !== 'undefined';
    const languageChanged = typeof req.body.language !== 'undefined';
    const mediaChanged =
      typeof req.body.mediaUrl !== 'undefined' ||
      typeof req.body.imageUrls !== 'undefined' ||
      typeof req.body.thumbnailUrl !== 'undefined' ||
      typeof req.body.videoUrl !== 'undefined';

    if (titleChanged || contentChanged || languageChanged || mediaChanged) {
      const previousContentHash = existingNews.contentHash || null;
      let contentHash = generateContentHash(news.title, news.content);
      let duplicateCheck = existingNews.duplicateCheck || null;

      try {
        const result = await runDuplicateCheckGateway(
          {
            title: news.title,
            content: news.content,
            language: news.language,
            mediaUrl: news.mediaUrl,
            mediaType: news.mediaType,
            imageUrls: news.imageUrls,
            thumbnailUrl: news.thumbnailUrl,
            videoUrl: news.videoUrl
          },
          {
            excludeId: news._id,
            includePendingCorpus: true
          }
        );
        contentHash = result.contentHash || contentHash;
        duplicateCheck = result.duplicateCheck || duplicateCheck;
      } catch (gateErr) {
        console.warn('Duplicate check in updateNews failed/timed out, using local hash fallback:', gateErr.message);
      }

      news.contentHash = contentHash;
      news.duplicateCheck = duplicateCheck;
      await news.save();

      // Phase-4.2 — fire-and-forget STALE→PENDING when contentHash changes. Never blocks publish.
      schedulePendingAfterUpdate({
        news,
        previousContentHash,
      });
      if (mediaChanged) {
        scheduleMediaFingerprint(news);
      }
    }

    // 🔄 Clear news cache after updating
    await clearCache('cache:/api/public/news*');
    await clearCache('cache:/api/public/locations*');

    res.json(news);
  } catch (error) {
    res.status(400).json({ error: 'Error updating news' });
  }
}

// Delete news (editors can only delete their own news)
async function deleteNews(req, res) {
  try {
    const { password } = req.body;
    
    // Check password from .env
    const envPassword = process.env.REJECTED_NEWS_DELETE_PASSWORD;
    if (!envPassword) {
      return res.status(500).json({ error: 'Delete password not configured in .env' });
    }
    
    if (password !== envPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // First, find the news to check ownership
    const existingNews = await News.findById(req.params.id);
    if (!existingNews) {
      return res.status(404).json({ error: 'News not found' });
    }

    const isSuperAdmin = req.admin.role === 'superadmin';
    const hasEditPerm = req.admin.role === 'subeditor' && req.admin.permissions && req.admin.permissions.canEditNews;
    const canEditAny = isSuperAdmin || req.admin.role === 'admin' || hasEditPerm;

    // Check if editor is trying to delete someone else's news
    if (!canEditAny && existingNews.authorId !== req.admin.id) {
      return res.status(403).json({ error: 'Access denied. You can only delete your own news.' });
    }

    // Check if news is rejected
    if (existingNews.rejectionStatus && existingNews.rejectionStatus.isRejected && !isSuperAdmin && !hasEditPerm) {
      return res.status(403).json({ error: 'Access denied. Rejected news cannot be deleted.' });
    }

    const news = await News.findByIdAndDelete(req.params.id);

    // Delete media from Cloudflare R2
    if (existingNews.mediaUrl) {
      await deleteFromR2(existingNews.mediaUrl);
      if (existingNews.mediaType === 'video' && existingNews.thumbnailUrl && existingNews.thumbnailUrl !== existingNews.mediaUrl) {
        await deleteFromR2(existingNews.thumbnailUrl);
      }
    }

    // 🔄 Clear news cache after deleting
    await clearCache('cache:/api/public/news*');
    await clearCache('cache:/api/public/locations*');

    res.json({ message: 'News deleted successfully' });
  } catch (error) {
    res.status(400).json({ error: 'Error deleting news' });
  }
}

// Toggle news active status
async function toggleNewsStatus(req, res) {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    console.log('Toggle news status called with:', { id, isActive, admin: req.admin }); // Debug log

    // Check if using MongoDB or in-memory storage
    if (req.app.locals.isConnectedToMongoDB) {
      console.log('Using MongoDB for toggle'); // Debug log

      // Import News model here to avoid circular dependency issues
      const News = require('../models/News');

      // First, find the news to check ownership
      const existingNews = await News.findById(id);
      console.log('Found news in MongoDB:', existingNews); // Debug log

      if (!existingNews) {
        console.log('News not found in MongoDB:', id); // Debug log
        return res.status(404).json({ error: 'News not found' });
      }

      const isSuperAdmin = req.admin.role === 'superadmin';
      const hasEditPerm = req.admin.role === 'subeditor' && req.admin.permissions && req.admin.permissions.canEditNews;
      const canEditAny = isSuperAdmin || req.admin.role === 'admin' || hasEditPerm;

      // Check if user is trying to toggle someone else's news
      if (!canEditAny && existingNews.authorId !== req.admin.id) {
        return res.status(403).json({ error: 'Access denied. You can only toggle your own news.' });
      }

      // Reporters cannot self-publish — pending/needs-revision must go through admin Approve
      if (!canEditAny && isActive === true) {
        return res.status(403).json({
          error:
            'Access denied. Reporters cannot publish news. Pending stories require admin approval.',
        });
      }

      // Check if news is rejected
      if (existingNews.rejectionStatus && existingNews.rejectionStatus.isRejected && !isSuperAdmin && !hasEditPerm) {
        return res.status(403).json({ error: 'Access denied. Rejected news cannot be toggled.' });
      }

      // Language Mismatch Check
      if (isActive === true && !req.body.ignoreLanguageWarning) {
        let expectedLanguageName = null;
        try {
            const { getActiveLanguages } = require('../services/languageRegistry');
            const activeLanguages = getActiveLanguages();
            
            const language = existingNews.language;
            const category = existingNews.category;
            
            if (language) {
                const selectedLanguage = activeLanguages.find(l => l.code === language || l.name.toLowerCase() === language.toLowerCase());
                if (selectedLanguage) {
                    expectedLanguageName = selectedLanguage.name;
                }
            }
            if (!expectedLanguageName && category) {
                const categoryLanguage = activeLanguages.find(l => l.name.toLowerCase() === category.toLowerCase());
                if (categoryLanguage) {
                    expectedLanguageName = categoryLanguage.name;
                }
            }
        } catch (err) {
            console.error('Error getting language for validation:', err);
        }
        
        if (expectedLanguageName && existingNews.content) {
           const { detectPrimaryLanguage } = require('../utils/languageUtils');
           const detectedData = detectPrimaryLanguage(existingNews.content);
           if (detectedData && detectedData.language) {
             const expectedLower = expectedLanguageName.toLowerCase();
             if (detectedData.language !== expectedLower) {
                return res.status(409).json({
                  error: 'Language mismatch',
                  warning: true,
                  message: `The language assigned to this reporter is ${expectedLanguageName} but the news posted is in ${detectedData.language.toUpperCase()}.`,
                  detectedLanguage: detectedData.language,
                  expectedCategory: expectedLanguageName
                });
             }
           }
        }
      }

      // Toggle the isActive status
      const updatedHistory = Array.isArray(existingNews.actionHistory) ? [...existingNews.actionHistory] : [];
      updatedHistory.push(
        buildHistoryEntry(
          'status_toggled',
          req.admin,
          `Status changed from ${existingNews.isActive ? 'Active' : 'Inactive'} to ${isActive ? 'Active' : 'Inactive'}`,
          { from: existingNews.isActive, to: isActive }
        )
      );

      const news = await News.findByIdAndUpdate(
        id,
        {
          isActive: isActive,
          isDeactivated: !isActive,
          actionHistory: updatedHistory
        },
        { new: true }
      );

      console.log('News status updated in MongoDB:', news); // Debug log
      res.json({ message: 'News status updated successfully', news });
    } else {
      console.log('Using in-memory storage for toggle'); // Debug log
      // Using in-memory storage
      const newsData = req.app.locals.newsData;
      const newsIndex = newsData.findIndex(news => news._id === id);

      if (newsIndex === -1) {
        console.log('News not found in in-memory storage:', id); // Debug log
        return res.status(404).json({ error: 'News not found' });
      }

      console.log('Found news in in-memory storage:', newsData[newsIndex]); // Debug log

      // Check if editor is trying to toggle someone else's news
      if (req.admin.role === 'editor' && newsData[newsIndex].authorId !== req.admin.id) {
        console.log('Editor trying to toggle someone else\'s news:', {
          editorId: req.admin.id,
          newsAuthorId: newsData[newsIndex].authorId
        }); // Debug log
        return res.status(403).json({ error: 'Access denied. You can only toggle your own news.' });
      }

      const isSuperAdminMem = req.admin.role === 'superadmin';
      const hasEditPermMem =
        req.admin.role === 'subeditor' &&
        req.admin.permissions &&
        req.admin.permissions.canEditNews;
      const canEditAnyMem =
        isSuperAdminMem || req.admin.role === 'admin' || hasEditPermMem;
      if (!canEditAnyMem && isActive === true) {
        return res.status(403).json({
          error:
            'Access denied. Reporters cannot publish news. Pending stories require admin approval.',
        });
      }

      // Language Mismatch Check
      if (isActive === true && !req.body.ignoreLanguageWarning) {
        let expectedLanguageName = null;
        try {
            const { getActiveLanguages } = require('../services/languageRegistry');
            const activeLanguages = getActiveLanguages();
            
            const language = newsData[newsIndex].language;
            const category = newsData[newsIndex].category;
            
            if (language) {
                const selectedLanguage = activeLanguages.find(l => l.code === language || l.name.toLowerCase() === language.toLowerCase());
                if (selectedLanguage) {
                    expectedLanguageName = selectedLanguage.name;
                }
            }
            if (!expectedLanguageName && category) {
                const categoryLanguage = activeLanguages.find(l => l.name.toLowerCase() === category.toLowerCase());
                if (categoryLanguage) {
                    expectedLanguageName = categoryLanguage.name;
                }
            }
        } catch (err) {
            console.error('Error getting language for validation:', err);
        }
        
        if (expectedLanguageName && newsData[newsIndex].content) {
           const { detectPrimaryLanguage } = require('../utils/languageUtils');
           const detectedData = detectPrimaryLanguage(newsData[newsIndex].content);
           if (detectedData && detectedData.language) {
             const expectedLower = expectedLanguageName.toLowerCase();
             if (detectedData.language !== expectedLower) {
                return res.status(409).json({
                  error: 'Language mismatch',
                  warning: true,
                  message: `The language assigned to this reporter is ${expectedLanguageName} but the news posted is in ${detectedData.language.toUpperCase()}.`,
                  detectedLanguage: detectedData.language,
                  expectedCategory: expectedLanguageName
                });
             }
           }
        }
      }

      // Toggle the isActive status
      newsData[newsIndex].isActive = isActive;
      newsData[newsIndex].isDeactivated = !isActive;
      newsData[newsIndex].actionHistory = newsData[newsIndex].actionHistory || [];
      newsData[newsIndex].actionHistory.push(
        buildHistoryEntry(
          'status_toggled',
          req.admin,
          `Status changed to ${isActive ? 'Active' : 'Inactive'}`,
          { to: isActive }
        )
      );

      console.log('News status updated in in-memory storage:', newsData[newsIndex]); // Debug log
      res.json({ message: 'News status updated successfully', news: newsData[newsIndex] });
    }
  } catch (error) {
    console.error('Error in toggleNewsStatus:', error); // Debug log
    res.status(500).json({ error: 'Error updating news status' });
  }
}
// --- Image Moderation Processing ---
async function processImage(req, res) {
  try {
    const { imageUrl, action, coordinates } = req.body;
    
    if (!imageUrl || !action) {
      return res.status(400).json({ success: false, message: 'Missing imageUrl or action' });
    }

    // 1. Download image buffer
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data, 'binary');

    let processedBuffer;
    
    // 2. Process image with sharp
    if (action === 'grayscale') {
      processedBuffer = await sharp(buffer)
        .grayscale()
        .webp({ quality: 80 })
        .toBuffer();
    } else if (action === 'blur') {
      if (!coordinates || coordinates.width <= 0 || coordinates.height <= 0) {
        return res.status(400).json({ success: false, message: 'Invalid coordinates for blur' });
      }
      
      const { x, y, width, height } = coordinates;
      
      // Extract the region to blur
      const region = await sharp(buffer)
        .extract({ left: Math.round(x), top: Math.round(y), width: Math.round(width), height: Math.round(height) })
        .blur(25)
        .toBuffer();
        
      // Composite back
      processedBuffer = await sharp(buffer)
        .composite([{ input: region, left: Math.round(x), top: Math.round(y) }])
        .webp({ quality: 80 })
        .toBuffer();
    } else {
      return res.status(400).json({ success: false, message: 'Invalid action' });
    }

    // 3. Upload back to R2
    const originalName = 'processed_image.webp'; 
    const folderName = 'short_news_images'; 
    const newImageUrl = await uploadToR2(processedBuffer, folderName, originalName, 'image/webp');

    res.json({ success: true, url: newImageUrl });
  } catch (error) {
    console.error('Error processing image:', error);
    res.status(500).json({ success: false, message: 'Failed to process image' });
  }
}

// Upload media (images or videos) and extract thumbnail for videos
async function uploadMedia(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileUrl = req.file.path;
    const fileType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    const thumbnailUrl = req.file.thumbnailPath || fileUrl;

    return res.json({
      mediaUrl: fileUrl,
      thumbnailUrl: thumbnailUrl,
      fileType: fileType
    });
  } catch (error) {
    console.error('Media upload error:', error);
    res.status(500).json({ error: 'Error uploading media' });
  }
}

// Extract thumbnail from video using ffmpeg
function extractVideoThumbnail(videoPath) {
  return new Promise((resolve, reject) => {
    const thumbnailPath = videoPath.replace(path.extname(videoPath), '_thumb.jpg');

    ffmpeg(videoPath)
      .screenshots({
        count: 1,
        folder: path.dirname(videoPath),
        filename: path.basename(thumbnailPath),
        size: '640x480'
      })
      .on('end', () => {
        resolve(thumbnailPath);
      })
      .on('error', (err) => {
        console.error('FFmpeg thumbnail extraction error:', err);
        reject(err);
      });
  });
}

// Render reports page
async function renderReportsPage(req, res) {
  try {
    res.render('reports', {
      admin: req.admin,
      activePage: 'reports'
    });
  } catch (error) {
    console.error('Error rendering reports page:', error);
    res.status(500).json({ error: 'Error rendering reports page' });
  }
}

// Update news view count manually by admin
async function updateViewCount(req, res) {
  try {
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Only superadmin can edit view counts.' });
    }

    const { id } = req.params;
    const { views } = req.body;

    if (views === undefined || isNaN(views) || views < 0) {
      return res.status(400).json({ error: 'Valid view count is required' });
    }

    if (req.app.locals.isConnectedToMongoDB) {
      const News = require('../models/News');
      const existingNews = await News.findById(id);

      if (!existingNews) {
        return res.status(404).json({ error: 'News not found' });
      }

      const news = await News.findByIdAndUpdate(
        id,
        {
          views: views
        },
        { new: true }
      );

      // Clear cache
      await clearCache('cache:/api/public/news*');

      res.json({ message: 'View count updated successfully', news });
    } else {
      // In-memory update
      const newsData = req.app.locals.newsData;
      const newsIndex = newsData.findIndex(n => n._id === id);

      if (newsIndex === -1) {
        return res.status(404).json({ error: 'News not found' });
      }

      const existingNews = newsData[newsIndex];
      existingNews.views = views;

      res.json({ message: 'View count updated successfully', news: existingNews });
    }
  } catch (error) {
    console.error('Error updating view count:', error);
    res.status(500).json({ error: 'Error updating view count' });
  }
}

async function updateLikeCount(req, res) {
  try {
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Only superadmin can edit like counts.' });
    }

    const { id } = req.params;
    const { likes } = req.body;

    if (likes === undefined || isNaN(likes) || likes < 0) {
      return res.status(400).json({ error: 'Valid like count is required' });
    }

    const news = await News.findByIdAndUpdate(id, { likes: Number(likes) }, { new: true });
    if (!news) {
      return res.status(404).json({ error: 'News not found' });
    }

    await clearCache('cache:/api/public/news*');
    res.json({ message: 'Like count updated successfully', news });
  } catch (error) {
    console.error('Error updating like count:', error);
    res.status(500).json({ error: 'Error updating like count' });
  }
}

async function updateDislikeCount(req, res) {
  try {
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Only superadmin can edit dislike counts.' });
    }

    const { id } = req.params;
    const { dislikes } = req.body;

    if (dislikes === undefined || isNaN(dislikes) || dislikes < 0) {
      return res.status(400).json({ error: 'Valid dislike count is required' });
    }

    const news = await News.findByIdAndUpdate(id, { dislikes: Number(dislikes) }, { new: true });
    if (!news) {
      return res.status(404).json({ error: 'News not found' });
    }

    await clearCache('cache:/api/public/news*');
    res.json({ message: 'Dislike count updated successfully', news });
  } catch (error) {
    console.error('Error updating dislike count:', error);
    res.status(500).json({ error: 'Error updating dislike count' });
  }
}

async function deleteNewsComment(req, res) {
  try {
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Only superadmin can delete comments.' });
    }

    const { id, commentId } = req.params;
    const news = await News.findById(id);
    if (!news) {
      return res.status(404).json({ error: 'News not found' });
    }

    const comment = news.userInteractions?.comments?.id(commentId);
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    comment.deleteOne();
    news.comments = Math.max(0, news.userInteractions.comments.length);
    news.markModified('userInteractions.comments');
    await news.save();
    await clearCache('cache:/api/public/news*');

    res.json({ message: 'Comment deleted successfully', news });
  } catch (error) {
    console.error('Error deleting news comment:', error);
    res.status(500).json({ error: 'Error deleting comment' });
  }
}

async function updateNewsComment(req, res) {
  try {
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Only superadmin can edit comments.' });
    }

    const { id, commentId } = req.params;
    const { comment: newComment } = req.body;

    if (!newComment || !String(newComment).trim()) {
      return res.status(400).json({ error: 'Comment text is required' });
    }

    const news = await News.findById(id);
    if (!news) {
      return res.status(404).json({ error: 'News not found' });
    }

    const comment = news.userInteractions?.comments?.id(commentId);
    if (!comment) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    comment.comment = String(newComment).trim();
    news.markModified('userInteractions.comments');
    await news.save();
    await clearCache('cache:/api/public/news*');

    res.json({ message: 'Comment updated successfully', news });
  } catch (error) {
    console.error('Error updating news comment:', error);
    res.status(500).json({ error: 'Error updating comment' });
  }
}

/**
 * Reporter Resubmit after Needs Revision.
 * Single workflow: apply edited fields + clear needsRevision + store change summary.
 * Idempotent: second call while not needsRevision → 409.
 */
async function resubmitNews(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'News ID is required' });
    }

    const existingNews = await News.findById(id);
    if (!existingNews) {
      return res.status(404).json({ error: 'News not found' });
    }

    // Ownership — resubmit is reporter workflow
    if (existingNews.authorId !== req.admin.id) {
      return res.status(403).json({
        error: 'Access denied. You can only resubmit your own news.',
      });
    }

    if (existingNews.isActive === true) {
      return res.status(400).json({
        error: 'Published news cannot be resubmitted.',
      });
    }

    if (existingNews.rejectionStatus && existingNews.rejectionStatus.isRejected) {
      return res.status(400).json({
        error: 'Rejected news cannot be resubmitted. Reject is final.',
      });
    }

    const prevRevision = existingNews.revisionStatus || {};
    if (prevRevision.needsRevision !== true) {
      return res.status(409).json({
        error:
          'News is not in Needs Revision. Resubmit is only allowed after an admin sends it back.',
      });
    }

    const {
      stripReporterForbiddenFields,
      buildChangeSummary,
    } = require('../services/newsRevision/revisionHelpers');

    const body = stripReporterForbiddenFields(req.body || {});

    if (req.admin.permissions?.requiresSourceLink) {
      const sourceLink =
        body.sourceLink !== undefined
          ? body.sourceLink
          : existingNews.sourceLink;
      if (!sourceLink || String(sourceLink).trim() === '') {
        return res.status(400).json({ error: 'Source Link is mandatory' });
      }
    }

    const authorForLang = await Admin.findById(req.admin.id).select(
      'workingLanguage allowedLanguages role'
    );
    const articleLanguage = normalizeNewsLanguage(
      body.language !== undefined ? body.language : existingNews.language
    );

    if (
      authorForLang &&
      authorForLang.role !== 'admin' &&
      authorForLang.role !== 'superadmin'
    ) {
      if (!isLanguageAllowedForEditor(authorForLang, articleLanguage)) {
        return res
          .status(403)
          .json({ error: 'You are not allowed to post news in this language.' });
      }
    }

    const effectiveScope =
      body.scope !== undefined ? body.scope : existingNews.scope || 'state';
    const effectiveLocation =
      body.location !== undefined ? body.location : existingNews.location;
    const postingAreaError = await validatePostingArea(
      req.admin,
      effectiveScope,
      effectiveLocation
    );
    if (postingAreaError) {
      return res.status(403).json({ error: postingAreaError });
    }

    const limits = await getDisplayLimitsForLanguage(articleLanguage);
    const titleForLimit =
      body.title !== undefined ? body.title : existingNews.title;
    const contentForLimit =
      body.content !== undefined ? body.content : existingNews.content;

    if (titleForLimit && stripTags(titleForLimit).length > limits.titleMax) {
      return res
        .status(400)
        .json({ error: `Title cannot exceed ${limits.titleMax} characters` });
    }
    if (
      contentForLimit &&
      stripTags(contentForLimit).length > limits.contentMax
    ) {
      return res.status(400).json({
        error: `Content cannot exceed ${limits.contentMax} characters`,
      });
    }

    if (body.content) {
      body.content = normalizeNewsContent(body.content);
    }
    if (body.title) {
      body.title = normalizeNewsContent(body.title);
    }

    const previousMediaUrl = existingNews.mediaUrl;
    const previousMediaType = existingNews.mediaType;
    const previousThumbnailUrl = existingNews.thumbnailUrl;

    // Build merged document in memory (do not save yet)
    const merged = existingNews.toObject();
    const applyKeys = [
      'title',
      'content',
      'category',
      'location',
      'scope',
      'language',
      'sourceLink',
      'readFullLink',
      'ePaperLink',
      'mediaUrl',
      'mediaType',
      'thumbnailUrl',
      'imageUrl',
      'imageUrls',
      'videoUrl',
    ];
    for (const key of applyKeys) {
      if (typeof body[key] !== 'undefined') {
        merged[key] = body[key];
      }
    }

    if (body.language !== undefined) {
      merged.language = normalizeNewsLanguage(body.language);
    }

    if (body.mediaUrl) {
      merged.mediaUrl = body.mediaUrl;
      if (body.mediaType) merged.mediaType = body.mediaType;
      if (body.thumbnailUrl) merged.thumbnailUrl = body.thumbnailUrl;
      if (body.mediaType === 'image') {
        merged.imageUrl = body.mediaUrl;
      }
    } else if (body.imageUrl) {
      merged.mediaUrl = body.imageUrl;
      merged.mediaType = 'image';
      merged.imageUrl = body.imageUrl;
      merged.thumbnailUrl = body.imageUrl;
    }

    const round =
      Number(prevRevision.lastRevisionRound) ||
      Number(prevRevision.revisionCount) ||
      1;

    const lastChangeSummary = buildChangeSummary(
      prevRevision.revisionSnapshot,
      merged,
      round
    );

    const resubmittedAt = new Date();
    const revisionStatus = {
      needsRevision: false,
      remarks: prevRevision.remarks || null,
      sentBackBy: prevRevision.sentBackBy || null,
      sentBackById: prevRevision.sentBackById || null,
      sentBackByRole: prevRevision.sentBackByRole || null,
      sentAt: prevRevision.sentAt || null,
      revisionCount: Number(prevRevision.revisionCount) || 0,
      lastRevisionRound: Number(prevRevision.lastRevisionRound) || 0,
      lastResubmitRound: round,
      resubmittedAt,
      revisionSnapshot: prevRevision.revisionSnapshot || null,
      lastChangeSummary,
    };

    const updatedHistory = Array.isArray(existingNews.actionHistory)
      ? [...existingNews.actionHistory]
      : [];
    updatedHistory.push(
      buildHistoryEntry(
        'resubmitted',
        req.admin,
        `News resubmitted for review (round ${round})`,
        {
          round,
          changedFields: lastChangeSummary.changedFields || [],
          changeSummaryRef: 'revisionStatus.lastChangeSummary',
        }
      )
    );

    const setPayload = {
      isActive: false,
      revisionStatus,
      actionHistory: updatedHistory,
    };
    for (const key of applyKeys) {
      if (typeof merged[key] !== 'undefined') {
        setPayload[key] = merged[key];
      }
    }

    // Optional duplicate metadata before atomic write (does not touch revision lock)
    const titleChanged = typeof body.title !== 'undefined';
    const contentChanged = typeof body.content !== 'undefined';
    const languageChanged = typeof body.language !== 'undefined';
    const mediaChanged =
      typeof body.mediaUrl !== 'undefined' ||
      typeof body.imageUrls !== 'undefined' ||
      typeof body.thumbnailUrl !== 'undefined' ||
      typeof body.videoUrl !== 'undefined' ||
      typeof body.imageUrl !== 'undefined';

    let previousContentHash = existingNews.contentHash || null;
    if (titleChanged || contentChanged || languageChanged || mediaChanged) {
      let contentHash = generateContentHash(merged.title, merged.content);
      let duplicateCheck = existingNews.duplicateCheck || null;

      try {
        const result = await runDuplicateCheckGateway(
          {
            title: merged.title,
            content: merged.content,
            language: merged.language,
            mediaUrl: merged.mediaUrl,
            mediaType: merged.mediaType,
            imageUrls: merged.imageUrls,
            thumbnailUrl: merged.thumbnailUrl,
            videoUrl: merged.videoUrl,
          },
          {
            excludeId: existingNews._id,
            includePendingCorpus: true,
          }
        );
        contentHash = result.contentHash || contentHash;
        duplicateCheck = result.duplicateCheck || duplicateCheck;
      } catch (gateErr) {
        console.warn('Duplicate check in updateNewsInline failed/timed out, using local hash fallback:', gateErr.message);
      }
      setPayload.contentHash = contentHash;
      setPayload.duplicateCheck = duplicateCheck;
    }

    // Atomic: Needs Revision + matching revisionCount (exclusive with concurrent send-back)
    const expectedRevisionCount = Number(prevRevision.revisionCount) || 0;
    const resubmitFilter = {
      _id: id,
      authorId: req.admin.id,
      isActive: { $ne: true },
      'rejectionStatus.isRejected': { $ne: true },
      'revisionStatus.needsRevision': true,
    };
    if (expectedRevisionCount === 0) {
      resubmitFilter.$and = [
        {
          $or: [
            { 'revisionStatus.revisionCount': 0 },
            { 'revisionStatus.revisionCount': { $exists: false } },
          ],
        },
      ];
    } else {
      resubmitFilter['revisionStatus.revisionCount'] = expectedRevisionCount;
    }

    const savedNews = await News.findOneAndUpdate(
      resubmitFilter,
      { $set: setPayload },
      { new: true }
    );

    if (!savedNews) {
      return res.status(409).json({
        error:
          'News is not in Needs Revision or state changed. Refresh and try again.',
      });
    }

    if (
      body.mediaUrl &&
      previousMediaUrl &&
      body.mediaUrl !== previousMediaUrl
    ) {
      await deleteFromR2(previousMediaUrl);
      if (
        previousMediaType === 'video' &&
        previousThumbnailUrl &&
        previousThumbnailUrl !== previousMediaUrl
      ) {
        await deleteFromR2(previousThumbnailUrl);
      }
    }

    if (titleChanged || contentChanged || languageChanged || mediaChanged) {
      schedulePendingAfterUpdate({
        news: savedNews,
        previousContentHash,
      });
      if (mediaChanged) {
        scheduleMediaFingerprint(savedNews);
      }
    }

    await clearCache('cache:/api/public/news*');
    await clearCache('cache:/api/public/locations*');

    const {
      emitWorkflowPair,
    } = require('../services/realtime/workflowEmit');
    const io = req.app.locals.io;
    if (io) {
      const editorPayload = {
        id: savedNews._id,
        authorId: savedNews.authorId || null,
        status: 'resubmitted',
        message: 'News submitted successfully. Waiting for review.',
        revisionStatus: {
          needsRevision: false,
          revisionCount: savedNews.revisionStatus.revisionCount,
          lastResubmitRound: round,
          resubmittedAt: savedNews.revisionStatus.resubmittedAt,
          changedFields: lastChangeSummary.changedFields || [],
        },
      };
      emitWorkflowPair(io, savedNews.authorId, editorPayload, {
        ...editorPayload,
        message: 'Reporter has resubmitted the article.',
        title: savedNews.title,
        author: savedNews.author || null,
        language: savedNews.language || null,
        location: savedNews.location || null,
        constituency: savedNews.authorConstituency || null,
        changedFields: lastChangeSummary.changedFields || [],
      });
    }

    return res.json({
      success: true,
      message: 'News submitted successfully. Waiting for review.',
      news: savedNews,
    });
  } catch (error) {
    console.error('Error resubmitting news:', error);
    return res.status(500).json({ error: 'Failed to resubmit news' });
  }
}

// Export all functions properly
module.exports = {
  renderDashboard,
  renderNewsListPage,
  renderAddNewsPage,
  renderEditNewsPage,
  renderReportsPage,
  getAllNews,
  getNewsById,
  createNews,
  validatePostingArea, // exported for scope-guard verification (no behavioural change)
  toggleNewsStatus,
  updateNews,
  resubmitNews,
  deleteNews,
  uploadMedia,
  processImage,
  updateViewCount,
  updateLikeCount,
  updateDislikeCount,
  deleteNewsComment,
  updateNewsComment
};