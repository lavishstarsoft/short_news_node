const Admin = require('../models/Admin');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config/secrets');
const geoip = require('geoip-lite');
const requestIp = require('request-ip');
const iplocation = require('iplocation').default;
const fetch = require('node-fetch');
const mongoose = require('mongoose');

// Add these model imports
const News = require('../models/News');
const Location = require('../models/Location');
const Category = require('../models/Category');
const newsController = require('./newsController');
const {
  normalizeNewsLanguage,
  buildNewsLanguageFilter,
  getLanguageViewData
} = require('../utils/newsLanguages');
const { canAccessSidebarMenu } = require('../utils/sidebarPermissionHelper');
const { normalizeNewsContent } = require('../utils/contentNormalize');
const {
  NEWS_TITLE_MAX,
  NEWS_CONTENT_MAX,
} = require('../constants/newsLimits');
const { getDisplayConfigForCode, refreshCache: refreshLanguageCache } = require('../services/languageRegistry');
const {
  applyReporterCoverageFields,
  applySubEditorCoveragePermissions,
  buildSubEditorAuthorFilter,
  buildPendingNewsFilterForSubEditor,
  getManagedReporterIds,
  getSubEditorManagedCoverage,
  normalizeApprovalScope,
  uniqueStrings
} = require('../utils/editorCoverageHelper');

// Import the Notification model
const Notification = require('../models/Notification');
const User = require('../models/User');
const RegistrationField = require('../models/RegistrationField');
const ReporterApplication = require('../models/ReporterApplication');

// Import OneSignal service
const oneSignalService = require('../services/oneSignalService');

// Import Similarity Detector helpers via duplicate gateway / services
const {
  normalizeDuplicateCheck
} = require('../services/duplicateCheckService');
const { runDuplicateCheckGateway } = require('../services/aiDuplicate/runDuplicateCheckGateway');

/** Pending-news duplicate check via AI gateway (Python /v1/detect; Node fallback if AI off/fails). */
async function applyPendingDuplicateCheckViaAi(newsId) {
  const article = await News.findById(newsId)
    .select('title content language mediaUrl mediaType imageUrls thumbnailUrl videoUrl')
    .lean();
  if (!article) return null;

  const { contentHash, duplicateCheck } = await runDuplicateCheckGateway(article, {
    excludeId: newsId,
    includePendingCorpus: true
  });

  await News.findByIdAndUpdate(newsId, {
    contentHash,
    duplicateCheck
  });

  return duplicateCheck;
}

function articleHasMedia(article) {
  if (!article) return false;
  if (article.mediaUrl || article.thumbnailUrl || article.videoUrl) return true;
  return Array.isArray(article.imageUrls) && article.imageUrls.some(Boolean);
}

/**
 * Pending page previously skipped AI when checkedAt existed — even after
 * media download failed and left a false-negative. Recheck when:
 * - never checked, or
 * - has media and not flagged and media cascade never hashed the query image
 * - fingerprint became ready after the last check
 */
function pendingNeedsAiRecheck(article) {
  const dc = article.duplicateCheck || {};
  if (dc.isDuplicate || dc.isSuspicious) return false;
  if (!dc.checkedAt) return true;
  if (!articleHasMedia(article)) return false;
  if (!dc.mediaPassAt) return true;
  const fp = article.mediaFingerprint || {};
  if (
    fp.status === 'ready' &&
    fp.computedAt &&
    new Date(fp.computedAt) > new Date(dc.checkedAt)
  ) {
    return true;
  }
  return false;
}

// Import cache clearing functionality
const { clearCache } = require('../middleware/cache');
const { invalidateCache } = require('../graphql/cache');

// Helper to strip color tags [c=#RRGGBB]...[/c] for length validation
const stripTags = (text) => {
  if (!text) return '';
  return text.toString()
    .replace(/\[c=#[0-9a-fA-F]{6}\]/gi, '')
    .replace(/\[\/c\]/gi, '')
    .replace(/\[b\]/gi, '')
    .replace(/\[\/b\]/gi, '');
};


function buildAdminNewsHistory(action, adminId, adminName, adminRole, details, metadata = {}) {
  return {
    action,
    performedById: adminId || null,
    performedByName: adminName || 'Editor',
    performedByRole: adminRole || 'Editor',
    details,
    metadata,
    performedAt: new Date()
  };
}

// Render login page
const renderLoginPage = (req, res) => {
  res.render('login', { error: null });
};

// Advanced location detection function
const detectAdvancedLocation = async (ip) => {
  try {
    // Enhanced location details with better defaults
    let locationDetails = {
      city: 'Unknown',
      region: 'Unknown',
      country: 'Unknown',
      timezone: 'Unknown',
      isp: 'Unknown',
      latitude: null,
      longitude: null,
      isVpn: false,
      riskLevel: 'low',
      confidence: 100
    };

    // Handle localhost IPs specially
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
      locationDetails.city = 'Localhost';
      locationDetails.region = 'Local';
      locationDetails.country = 'Local';
      locationDetails.isp = 'Local Development';
      locationDetails.isVpn = true;
      locationDetails.riskLevel = 'high';
      locationDetails.confidence = 90;
      // Use default coordinates for localhost (somewhere in the ocean)
      locationDetails.latitude = 0.000000;
      locationDetails.longitude = 0.000000;

      return locationDetails;
    }

    // Get basic location from geoip-lite
    const geo = geoip.lookup(ip);

    if (geo) {
      locationDetails.city = geo.city || 'Unknown';
      locationDetails.region = geo.region || 'Unknown';
      locationDetails.country = geo.country || 'Unknown';
      locationDetails.timezone = geo.timezone || 'Unknown';
      // GeoIP-lite doesn't provide lat/long, so we'll fetch it separately
    }

    // Fetch latitude and longitude using iplocation
    try {
      // Add a 2-second timeout to prevent iplocation from hanging the login process
      const ipLocationData = await Promise.race([
        iplocation(ip),
        new Promise((_, reject) => setTimeout(() => reject(new Error('iplocation timeout')), 2000))
      ]);
      
      if (ipLocationData && ipLocationData.latitude && ipLocationData.longitude) {
        locationDetails.latitude = ipLocationData.latitude;
        locationDetails.longitude = ipLocationData.longitude;
      }

      // If we got location data from iplocation, use it to enhance our details
      if (ipLocationData) {
        if (ipLocationData.city && locationDetails.city === 'Unknown') {
          locationDetails.city = ipLocationData.city;
        }
        if (ipLocationData.region && locationDetails.region === 'Unknown') {
          locationDetails.region = ipLocationData.region;
        }
        if (ipLocationData.country && locationDetails.country === 'Unknown') {
          locationDetails.country = ipLocationData.country;
        }
      }
    } catch (ipLocationError) {
      console.log('IP location error:', ipLocationError);
    }

    // Check for VPN/proxy indicators
    const vpnIndicators = await checkVpnIndicators(ip);
    locationDetails.isVpn = vpnIndicators.isVpn;
    locationDetails.riskLevel = vpnIndicators.riskLevel;
    locationDetails.confidence = vpnIndicators.confidence;
    locationDetails.isp = vpnIndicators.isp || locationDetails.isp;

    // If we still don't have basic location info but have coordinates, 
    // try to reverse geocode them (simplified approach)
    if (locationDetails.city === 'Unknown' &&
      locationDetails.region === 'Unknown' &&
      locationDetails.country === 'Unknown' &&
      locationDetails.latitude &&
      locationDetails.longitude) {
      // This would be a good place to add reverse geocoding
      // For now, we'll just indicate we have coordinates
      locationDetails.city = 'Coordinates Only';
      locationDetails.region = 'Coordinates Only';
      locationDetails.country = 'Coordinates Only';
    }

    return locationDetails;
  } catch (error) {
    console.error('Advanced location detection error:', error);
    return {
      city: 'Error',
      region: 'Error',
      country: 'Error',
      timezone: 'Error',
      isp: 'Error',
      latitude: null,
      longitude: null,
      isVpn: false,
      riskLevel: 'low',
      confidence: 0
    };
  }
};

// Check for VPN/proxy indicators
const checkVpnIndicators = async (ip) => {
  const result = {
    isVpn: false,
    riskLevel: 'low',
    confidence: 100,
    isp: 'Unknown'
  };

  try {
    // Check against known VPN IP ranges (simplified check)
    // In a production environment, you would use a service like IPQualityScore or IPHub
    const suspiciousIps = [
      '127.0.0.1', // Localhost
      '::1'        // IPv6 localhost
    ];

    if (suspiciousIps.includes(ip)) {
      result.isVpn = true;
      result.riskLevel = 'high';
      result.confidence = 90;
      result.isp = 'Local/VPN Service';
      return result;
    }

    // Additional checks for VPN characteristics
    // This is a simplified implementation - in production you would use a dedicated service

    // Check if IP belongs to known datacenter ranges (simplified)
    if (ip.startsWith('10.') || ip.startsWith('172.') || ip.startsWith('192.168.')) {
      result.isVpn = true;
      result.riskLevel = 'medium';
      result.confidence = 70;
      result.isp = 'Private Network/Datacenter';
    }

    return result;
  } catch (error) {
    console.error('VPN detection error:', error);
    return result;
  }
};

// Handle login
const login = async (req, res) => {
  try {
    const { username, password, latitude, longitude, locationPermission } = req.body;

    // Validate input
    if (!username || !password) {
      return res.render('login', { error: 'Please provide username and password' });
    }

    // Check if MongoDB is connected
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    let admin;

    if (isConnectedToMongoDB) {
      // Find admin by username in MongoDB
      admin = await Admin.findOne({ username: username });
    } else {
      // Use in-memory storage for admins
      const admins = req.app.locals.adminData || [];
      admin = admins.find(a => a.username === username);
    }

    // Check if admin exists
    if (!admin) {
      return res.render('login', { error: 'Invalid credentials' });
    }

    // Check if admin is active
    if (!admin.isActive) {
      return res.render('login', { error: 'Account is deactivated' });
    }

    // Restrict access for editors and subeditors to the admin dashboard
    if (admin.role === 'editor') {
      return res.render('login', { error: 'You only have access to the Reporters Portal' });
    }
    if (admin.role === 'subeditor' && (!admin.permissions || !admin.permissions.canAccessAdminDashboard)) {
      return res.render('login', { error: 'You only have access to the Reporters Portal' });
    }

    // Compare password
    let isMatch;
    if (isConnectedToMongoDB) {
      isMatch = await admin.comparePassword(password);
    } else {
      // For in-memory storage, compare plain text (in a real app, you'd want to hash these too)
      isMatch = admin.password === password;
    }

    if (!isMatch) {
      return res.render('login', { error: 'Invalid credentials' });
    }

    // Get IP address using request-ip for better accuracy
    const ip = requestIp.getClientIp(req) || req.connection.remoteAddress || req.ip;

    // Get user agent
    const userAgent = req.headers['user-agent'] || 'Unknown';

    // Get advanced location information
    const locationDetails = await detectAdvancedLocation(ip);

    // Use client-side location data (highest priority)
    const clientLat = parseFloat(latitude);
    const clientLon = parseFloat(longitude);

    if (!isNaN(clientLat) && !isNaN(clientLon)) {
      locationDetails.latitude = clientLat;
      locationDetails.longitude = clientLon;
    }

    // Format location string with more detailed information
    let location = 'Unknown Location';
    const locationParts = [];

    // Build location string from available data
    if (locationDetails.city && locationDetails.city !== 'Unknown') {
      locationParts.push(locationDetails.city);
    }
    if (locationDetails.region && locationDetails.region !== 'Unknown') {
      locationParts.push(locationDetails.region);
    }
    if (locationDetails.country && locationDetails.country !== 'Unknown') {
      locationParts.push(locationDetails.country);
    }

    // If we have location parts, use them
    if (locationParts.length > 0) {
      location = locationParts.join(', ');
    } else if (locationDetails.isp && locationDetails.isp !== 'Unknown') {
      // Fallback to ISP if no location data
      location = locationDetails.isp;
    }

    // Add coordinates to location string for better identification
    if (locationDetails.latitude && locationDetails.longitude) {
      location += ` (${locationDetails.latitude.toFixed(6)}, ${locationDetails.longitude.toFixed(6)})`;
    }

    // Add warning for VPN usage
    if (locationDetails.isVpn) {
      location += ` [WARNING: Possible VPN detected - Risk Level: ${locationDetails.riskLevel}]`;
    }

    // Add login history with enhanced location details (only if MongoDB is connected)
    if (isConnectedToMongoDB) {
      await admin.addLoginHistory(ip, userAgent, location, locationDetails);

      // Update last login
      admin.lastLogin = new Date();
      await admin.save();
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        id: isConnectedToMongoDB ? admin._id : admin.id, 
        username: admin.username, 
        role: admin.role,
        permissions: admin.permissions || {}
      },
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    // Set cookie (secure + sameSite in production to mitigate CSRF / sniffing)
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    });

    // Redirect to dashboard
    res.redirect('/');
  } catch (error) {
    console.error('Login error:', error);
    res.render('login', { error: 'An error occurred during login' });
  }
};

// Handle logout
const logout = (req, res) => {
  res.clearCookie('token');
  res.redirect('/login');
};

// Render profile page
const renderProfilePage = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    res.render('profile', { admin });
  } catch (error) {
    console.error('Profile error:', error);
    res.redirect('/login');
  }
};

// Handle profile update
const updateProfile = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const adminId = req.admin.id;

    // Find admin by ID
    const admin = await Admin.findById(adminId);
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    // Verify current password
    const isMatch = await admin.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Update password
    admin.password = newPassword;
    await admin.save();

    res.json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'An error occurred while updating profile' });
  }
};

// Update profile image
const updateProfileImage = async (req, res) => {
  try {
    const adminId = req.admin.id;

    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    // Find admin by ID
  } catch (error) {
    console.error('Profile image update error:', error);
    res.status(500).json({ error: 'An error occurred while updating profile image' });
  }
};


// Render users list page with detailed interactions
const renderUsersListPage = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    // Import User and News models
    const User = require('../models/User');
    const News = require('../models/News');

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(10, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const searchQuery = (req.query.search || '').trim();
    const authFilter = ['google', 'mobile'].includes(req.query.auth) ? req.query.auth : '';

    const filterConditions = [];
    if (searchQuery) {
      filterConditions.push({
        $or: [
          { displayName: { $regex: searchQuery, $options: 'i' } },
          { email: { $regex: searchQuery, $options: 'i' } },
          { mobileNumber: { $regex: searchQuery, $options: 'i' } }
        ]
      });
    }
    if (authFilter === 'google') {
      filterConditions.push({ googleId: { $exists: true, $ne: null, $ne: '' } });
    } else if (authFilter === 'mobile') {
      filterConditions.push({ mobileNumber: { $exists: true, $ne: null, $ne: '' } });
      filterConditions.push({
        $or: [
          { googleId: { $exists: false } },
          { googleId: null },
          { googleId: '' }
        ]
      });
    }

    let userQuery = {};
    if (filterConditions.length === 1) {
      userQuery = filterConditions[0];
    } else if (filterConditions.length > 1) {
      userQuery = { $and: filterConditions };
    }

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const [
      totalFiltered,
      users,
      statsTotal,
      statsGoogle,
      statsMobile,
      statsActiveWeek
    ] = await Promise.all([
      User.countDocuments(userQuery),
      User.find(userQuery).sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(),
      User.countDocuments({ googleId: { $exists: true, $ne: null, $ne: '' } }),
      User.countDocuments({
        mobileNumber: { $exists: true, $ne: null, $ne: '' },
        $or: [{ googleId: { $exists: false } }, { googleId: null }, { googleId: '' }]
      }),
      User.countDocuments({ lastLogin: { $gte: weekAgo } })
    ]);

    const totalPages = Math.max(1, Math.ceil(totalFiltered / limit));

    const userIds = users.map(user => user.googleId || user._id.toString());

    // Aggregate likes from news
    const likesAgg = await News.aggregate([
      { $match: { 'userInteractions.likes.userId': { $in: userIds } } },
      { $unwind: '$userInteractions.likes' },
      { $match: { 'userInteractions.likes.userId': { $in: userIds } } },
      { $group: {
        _id: '$userInteractions.likes.userId',
        count: { $sum: 1 },
        newsItems: {
          $push: {
            newsId: '$_id',
            title: '$title',
            category: '$category',
            publishedAt: '$publishedAt'
          }
        }
      }}
    ]);

    // Aggregate dislikes from news
    const dislikesAgg = await News.aggregate([
      { $match: { 'userInteractions.dislikes.userId': { $in: userIds } } },
      { $unwind: '$userInteractions.dislikes' },
      { $match: { 'userInteractions.dislikes.userId': { $in: userIds } } },
      { $group: {
        _id: '$userInteractions.dislikes.userId',
        count: { $sum: 1 },
        newsItems: {
          $push: {
            newsId: '$_id',
            title: '$title',
            category: '$category',
            publishedAt: '$publishedAt'
          }
        }
      }}
    ]);

    // Aggregate comments from news
    const commentsAgg = await News.aggregate([
      { $match: { 'userInteractions.comments.userId': { $in: userIds } } },
      { $unwind: '$userInteractions.comments' },
      { $match: { 'userInteractions.comments.userId': { $in: userIds } } },
      { $group: {
        _id: '$userInteractions.comments.userId',
        count: { $sum: 1 },
        newsItems: {
          $push: {
            newsId: '$_id',
            title: '$title',
            category: '$category',
            publishedAt: '$publishedAt',
            comment: '$userInteractions.comments.comment',
            timestamp: '$userInteractions.comments.timestamp'
          }
        }
      }}
    ]);

    // Create activity lookup maps
    const likesMap = {};
    const dislikesMap = {};
    const commentsMap = {};

    likesAgg.forEach(item => {
      likesMap[item._id] = { count: item.count, items: item.newsItems };
    });

    dislikesAgg.forEach(item => {
      dislikesMap[item._id] = { count: item.count, items: item.newsItems };
    });

    commentsAgg.forEach(item => {
      commentsMap[item._id] = { count: item.count, items: item.newsItems };
    });

    // Map users with aggregated activity data
    const usersWithInteractions = users.map(user => {
      const userObj = user.toObject();
      // Use googleId instead of _id for matching (News interactions store googleId as userId)
      const userId = user.googleId || user._id.toString(); // Fallback to _id for mobile users

      // Set aggregated interaction data
      userObj.interactions = {
        likes: likesMap[userId]?.items || [],
        dislikes: dislikesMap[userId]?.items || [],
        comments: commentsMap[userId]?.items || []
      };

      // Add counts for easy access
      userObj.activityCounts = {
        likes: likesMap[userId]?.count || 0,
        dislikes: dislikesMap[userId]?.count || 0,
        comments: commentsMap[userId]?.count || 0
      };

      return userObj;
    });

    res.render('users', {
      admin,
      users: usersWithInteractions,
      searchQuery,
      authFilter,
      stats: {
        total: statsTotal,
        google: statsGoogle,
        mobile: statsMobile,
        activeWeek: statsActiveWeek
      },
      pagination: {
        currentPage: page,
        limit,
        totalUsers: totalFiltered,
        totalPages
      }
    });
  } catch (error) {
    console.error('Users list error:', error);
    res.status(500).send('Error fetching users list');
  }
};

// Render dashboard page
async function renderDashboard(req, res) {
  try {
    if (req.app.locals.isConnectedToMongoDB) {
      let newsList;
      let totalNewsCount;
      let activeNewsCount;
      let inactiveNewsCount;

      // Check user role
      if (req.admin.role === 'editor') {
        // Editors only see their own news
        newsList = await News.find({ authorId: req.admin.id }).sort({ publishedAt: -1 }).limit(12);
        totalNewsCount = await News.countDocuments({ authorId: req.admin.id });
        activeNewsCount = await News.countDocuments({ authorId: req.admin.id, isActive: true });
        inactiveNewsCount = await News.countDocuments({ authorId: req.admin.id, isActive: false });
      } else if (req.admin.role === 'subeditor') {
        // Sub-editors: own scope matrame (data isolation)
        const subDoc = await Admin.findById(req.admin.id).lean();
        const scopeFilter = subDoc ? await buildAnalyticsScopeFilter(subDoc) : {};
        newsList = await News.find(scopeFilter).sort({ publishedAt: -1 }).limit(12);
        totalNewsCount = await News.countDocuments(scopeFilter);
        activeNewsCount = await News.countDocuments({ ...scopeFilter, isActive: true });
        inactiveNewsCount = await News.countDocuments({ ...scopeFilter, isActive: false });
      } else {
        // Admins and superadmins see all news, but limit to latest 12
        newsList = await News.find().sort({ publishedAt: -1 }).limit(12);
        totalNewsCount = await News.countDocuments();
        activeNewsCount = await News.countDocuments({ isActive: true });
        inactiveNewsCount = await News.countDocuments({ isActive: false });
      }

      const categories = await Category.find({ type: { $in: ['news', null] } });
      const locations = await Location.find();

      // Get all locations to create a map of name to code
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

      // Calculate today's news count
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let todaysNewsCount;

      if (req.admin.role === 'editor') {
        // Editors only see their own today's news count
        todaysNewsCount = await News.countDocuments({
          authorId: req.admin.id,
          publishedAt: { $gte: today }
        });
      } else if (req.admin.role === 'subeditor') {
        const subDoc = await Admin.findById(req.admin.id).lean();
        const scopeFilter = subDoc ? await buildAnalyticsScopeFilter(subDoc) : {};
        todaysNewsCount = await News.countDocuments({
          ...scopeFilter,
          publishedAt: { $gte: today }
        });
      } else {
        // Admins and superadmins see all today's news count
        todaysNewsCount = await News.countDocuments({
          publishedAt: { $gte: today }
        });
      }

      res.render('index', {
        newsList: newsListWithCodes,
        categories,
        locations,
        todaysNewsCount,
        totalNewsCount,
        activeNewsCount,
        inactiveNewsCount,
        admin: req.admin
      });
    } else {
      // Use in-memory storage
      const newsData = req.app.locals.newsData || [];
      const categoryData = req.app.locals.categoryData || [];
      const locationData = req.app.locals.locationData || [];

      // Calculate counts for in-memory data
      const totalNewsCount = newsData.length;
      const activeNewsCount = newsData.filter(news => news.isActive !== false).length;
      const inactiveNewsCount = newsData.filter(news => news.isActive === false).length;

      // Calculate today's news count for in-memory data
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todaysNewsCount = newsData.filter(news => {
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
          locationCode: news.location ? locationMap[news.location] : null
        };
      });

      res.render('index', {
        newsList: newsListWithCodes,
        categories: categoryData,
        locations: locationData,
        todaysNewsCount,
        totalNewsCount,
        activeNewsCount,
        inactiveNewsCount,
        admin: req.admin
      });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error fetching news' });
  }
}

// ==================== SCOPED ANALYTICS DASHBOARD ====================

/**
 * Ee admin ki e news kanipinchalo cheppe Mongo filter.
 * - superadmin/admin: anni
 * - editor (reporter): tana news matrame
 * - subeditor: own news + managed reporters + (geography scope aithe) managed locations.
 *   canViewAllNews true unte anni.
 * Filter eppudu DB lo unna Admin doc nunchi build avtundi — client input kadu.
 */
async function buildAnalyticsScopeFilter(adminDoc) {
  const role = adminDoc?.role;
  if (role === 'superadmin' || role === 'admin') return {};

  const selfId = String(adminDoc._id || adminDoc.id);
  if (role === 'editor') return { authorId: selfId };

  // subeditor
  const perms = adminDoc.permissions || {};
  if (perms.canViewAllNews) return {};

  const orClauses = [{ authorId: selfId }];
  const reporterIds = await getManagedReporterIds(Admin, adminDoc);
  if (reporterIds.length) {
    orClauses.push({ authorId: { $in: reporterIds } });
  }
  if (normalizeApprovalScope(perms.approvalScope) === 'geography') {
    const coverage = getSubEditorManagedCoverage(adminDoc);
    const names = uniqueStrings([
      ...coverage.states,
      ...coverage.districts,
      ...coverage.constituencies,
      ...coverage.locations
    ]);
    if (names.length) orClauses.push({ location: { $in: names } });
  }
  return { $or: orClauses };
}

/** IST (Asia/Kolkata) lo roju start Date object */
function istDayStart(base = new Date(), offsetDays = 0) {
  const d = new Date(base);
  d.setDate(d.getDate() - offsetDays);
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
  return new Date(`${ymd}T00:00:00.000+05:30`);
}

/** Date filter resolve — invalid input reject, custom range max 366 days */
function resolveAnalyticsDateRange(query) {
  const range = String(query.range || '30d');
  const now = new Date();
  const todayStart = istDayStart(now);

  switch (range) {
    case 'today':
      return { from: todayStart, to: now, label: "Today's Posts" };
    case 'yesterday':
      return { from: istDayStart(now, 1), to: new Date(todayStart.getTime() - 1), label: 'Yesterday' };
    case '7d':
      return { from: istDayStart(now, 6), to: now, label: 'Last 7 Days' };
    case '30d':
      return { from: istDayStart(now, 29), to: now, label: 'Last 30 Days' };
    case 'thisMonth': {
      const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
      const from = new Date(`${ymd.slice(0, 7)}-01T00:00:00.000+05:30`);
      return { from, to: now, label: 'This Month' };
    }
    case 'lastMonth': {
      const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
      const thisMonthStart = new Date(`${ymd.slice(0, 7)}-01T00:00:00.000+05:30`);
      const lastMonthStart = new Date(thisMonthStart);
      lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
      return { from: lastMonthStart, to: new Date(thisMonthStart.getTime() - 1), label: 'Last Month' };
    }
    case 'custom': {
      const fromStr = String(query.from || '');
      const toStr = String(query.to || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
        return { error: 'Custom range needs from & to dates (YYYY-MM-DD)' };
      }
      const from = new Date(`${fromStr}T00:00:00.000+05:30`);
      const to = new Date(`${toStr}T23:59:59.999+05:30`);
      if (isNaN(from) || isNaN(to) || from > to) {
        return { error: 'Invalid custom date range' };
      }
      if ((to - from) / 86400000 > 366) {
        return { error: 'Custom range cannot exceed 1 year' };
      }
      return { from, to, label: `${fromStr} → ${toStr}` };
    }
    default:
      return { from: istDayStart(now, 29), to: now, label: 'Last 30 Days' };
  }
}

/** Sub-editor/reporter assigned locations tree (State → District → Constituency) */
async function buildAssignedLocationTree(adminDoc) {
  const perms = adminDoc.permissions || {};
  const states = uniqueStrings([
    ...(adminDoc.assignedStates || []),
    ...(perms.managedStates || [])
  ]);
  const districts = uniqueStrings([
    ...(adminDoc.assignedDistricts || []),
    ...(perms.managedDistricts || [])
  ]);
  const constituencies = uniqueStrings([
    ...(adminDoc.assignedConstituencies || []),
    ...(perms.managedConstituencies || [])
  ]);

  if (!states.length && !districts.length && !constituencies.length) return [];

  // Parent resolve cheyadaniki Location docs okesari techukuntam
  const locDocs = await Location.find({
    name: { $in: [...districts, ...constituencies] }
  }).select('name locationType parentName').lean();
  const parentByName = {};
  locDocs.forEach(l => { parentByName[l.name] = l.parentName || null; });

  const tree = {};
  const ensureState = (name) => {
    if (!tree[name]) tree[name] = { name, districts: {} };
    return tree[name];
  };
  const ensureDistrict = (stateName, distName) => {
    const st = ensureState(stateName || 'Other');
    if (!st.districts[distName]) st.districts[distName] = { name: distName, constituencies: [] };
    return st.districts[distName];
  };

  states.forEach(s => ensureState(s));
  districts.forEach(d => ensureDistrict(parentByName[d] || states[0] || 'Other', d));
  constituencies.forEach(c => {
    const dist = parentByName[c];
    if (dist) {
      ensureDistrict(parentByName[dist] || states[0] || 'Other', dist).constituencies.push(c);
    } else {
      ensureDistrict(states[0] || 'Other', 'Other').constituencies.push(c);
    }
  });

  return Object.values(tree).map(st => ({
    name: st.name,
    districts: Object.values(st.districts).map(d => ({
      name: d.name,
      constituencies: d.constituencies.sort()
    })).sort((a, b) => a.name.localeCompare(b.name))
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * GET /admin/api/scoped-analytics
 * Role-based analytics: summary, category-wise, status-wise, daily trend,
 * reporter-wise — antha okka $facet aggregation lo.
 */
async function getScopedAnalytics(req, res) {
  try {
    const requester = await Admin.findById(req.admin.id).lean();
    if (!requester) return res.status(401).json({ error: 'Unauthorized' });

    const isFullAccess = requester.role === 'superadmin' || requester.role === 'admin';

    // Superadmin "View as" — oka sub-editor scope ni chudataniki
    let scopeAdmin = requester;
    const viewAs = String(req.query.viewAs || '').trim();
    if (viewAs && isFullAccess) {
      if (!mongoose.Types.ObjectId.isValid(viewAs)) {
        return res.status(400).json({ error: 'Invalid viewAs id' });
      }
      const target = await Admin.findById(viewAs).lean();
      if (!target || !['editor', 'subeditor'].includes(target.role)) {
        return res.status(404).json({ error: 'View target not found' });
      }
      scopeAdmin = target;
    }

    const rangeInfo = resolveAnalyticsDateRange(req.query);
    if (rangeInfo.error) return res.status(400).json({ error: rangeInfo.error });
    const { from, to, label } = rangeInfo;

    const scopeFilter = await buildAnalyticsScopeFilter(scopeAdmin);
    const match = { ...scopeFilter, publishedAt: { $gte: from, $lte: to } };

    const [facets] = await News.aggregate([
      { $match: match },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                published: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
                approved: { $sum: { $cond: [{ $eq: ['$approvalStatus.isApproved', true] }, 1, 0] } },
                rejected: { $sum: { $cond: [{ $eq: ['$rejectionStatus.isRejected', true] }, 1, 0] } },
                pending: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ['$isActive', true] },
                          { $ne: ['$rejectionStatus.isRejected', true] },
                          { $ne: ['$approvalStatus.isApproved', true] }
                        ]
                      },
                      1, 0
                    ]
                  }
                },
                draft: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $ne: ['$isActive', true] },
                          { $eq: ['$approvalStatus.isApproved', true] },
                          { $ne: ['$rejectionStatus.isRejected', true] }
                        ]
                      },
                      1, 0
                    ]
                  }
                },
                views: { $sum: { $ifNull: ['$views', 0] } }
              }
            }
          ],
          byCategory: [
            {
              $group: {
                _id: { $ifNull: ['$category', 'Uncategorized'] },
                count: { $sum: 1 },
                published: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } }
              }
            },
            { $sort: { count: -1 } }
          ],
          dailyTrend: [
            {
              $group: {
                _id: {
                  $dateToString: { format: '%Y-%m-%d', date: '$publishedAt', timezone: 'Asia/Kolkata' }
                },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } },
            { $limit: 370 }
          ],
          byReporter: [
            {
              $group: {
                _id: '$authorId',
                author: { $first: '$author' },
                total: { $sum: 1 },
                approved: { $sum: { $cond: [{ $eq: ['$approvalStatus.isApproved', true] }, 1, 0] } },
                rejected: { $sum: { $cond: [{ $eq: ['$rejectionStatus.isRejected', true] }, 1, 0] } },
                views: { $sum: { $ifNull: ['$views', 0] } }
              }
            },
            { $sort: { total: -1 } },
            { $limit: 20 }
          ],
          byLocation: [
            {
              $group: {
                _id: { $ifNull: ['$location', 'No location'] },
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 15 }
          ]
        }
      }
    ]).allowDiskUse(true);

    const summary = facets.summary[0] || {
      total: 0, published: 0, approved: 0, rejected: 0, pending: 0, draft: 0, views: 0
    };
    delete summary._id;
    summary.approvalRate = summary.total ? Math.round((summary.approved / summary.total) * 100) : 0;
    summary.rejectionRate = summary.total ? Math.round((summary.rejected / summary.total) * 100) : 0;

    // All-time totals (date filter lekunda, same scope)
    const [allTimeAgg] = await News.aggregate([
      { $match: scopeFilter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          approved: { $sum: { $cond: [{ $eq: ['$approvalStatus.isApproved', true] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$rejectionStatus.isRejected', true] }, 1, 0] } },
          pending: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$isActive', true] },
                    { $ne: ['$rejectionStatus.isRejected', true] },
                    { $ne: ['$approvalStatus.isApproved', true] }
                  ]
                },
                1, 0
              ]
            }
          },
          views: { $sum: { $ifNull: ['$views', 0] } }
        }
      }
    ]).allowDiskUse(true);
    const allTime = allTimeAgg || { total: 0, approved: 0, rejected: 0, pending: 0, views: 0 };
    delete allTime._id;
    allTime.approvalRate = allTime.total ? Math.round((allTime.approved / allTime.total) * 100) : 0;
    allTime.rejectionRate = allTime.total ? Math.round((allTime.rejected / allTime.total) * 100) : 0;
    allTime.pendingRate = allTime.total ? Math.round((allTime.pending / allTime.total) * 100) : 0;

    // Zero-count categories kuda list lo kanipinchali
    const allCategories = await Category.find({ type: { $in: ['news', null] } }).select('name').lean();
    const catCounts = {};
    facets.byCategory.forEach(c => { catCounts[c._id] = c; });
    const categories = allCategories.map(c => ({
      name: c.name,
      count: catCounts[c.name]?.count || 0,
      published: catCounts[c.name]?.published || 0
    }));
    // DB categories list lo leni (old/custom) category names kuda add
    facets.byCategory.forEach(c => {
      if (!allCategories.some(a => a.name === c._id)) {
        categories.push({ name: c._id, count: c.count, published: c.published });
      }
    });
    categories.sort((a, b) => b.count - a.count);

    // Assigned locations tree (sub-editor / reporter view ki matrame)
    let assignedLocations = null;
    if (['editor', 'subeditor'].includes(scopeAdmin.role)) {
      assignedLocations = await buildAssignedLocationTree(scopeAdmin);
    }

    // Superadmin dropdown ki view targets
    let viewTargets = null;
    if (isFullAccess && !viewAs) {
      viewTargets = await Admin.find({ role: 'subeditor' })
        .select('name username role')
        .sort({ name: 1 })
        .lean();
      viewTargets = viewTargets.map(t => ({
        id: String(t._id),
        name: t.name || t.username,
        role: t.role
      }));
    }

    res.json({
      range: { from, to, label },
      scope: {
        role: scopeAdmin.role,
        name: scopeAdmin.name || scopeAdmin.username,
        viewingAs: viewAs || null,
        fullAccess: isFullAccess && !viewAs
      },
      summary,
      allTime,
      categories,
      dailyTrend: facets.dailyTrend.map(d => ({ date: d._id, count: d.count })),
      reporters: facets.byReporter.map(r => ({
        authorId: r._id,
        author: r.author || 'Unknown',
        total: r.total,
        approved: r.approved,
        rejected: r.rejected,
        pending: Math.max(0, r.total - r.approved - r.rejected),
        views: r.views
      })),
      locations: facets.byLocation.map(l => ({ name: l._id, count: l.count })),
      assignedLocations,
      viewTargets
    });
  } catch (error) {
    console.error('Scoped analytics error:', error);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
}

// Render impersonated dashboard for a specific sub-editor
async function renderImpersonatedDashboard(req, res) {
  try {
    const targetEditorId = req.params.id;
    const targetAdmin = await Admin.findById(targetEditorId).lean();
    if (!targetAdmin) {
      return res.status(404).send('Editor not found');
    }
    
    targetAdmin.id = targetAdmin._id.toString();
    targetAdmin.isImpersonated = true;
    targetAdmin.impersonatorName = req.admin.name || 'Super Admin';

    let totalNewsCount = 0;
    let activeNewsCount = 0;
    let inactiveNewsCount = 0;
    let pendingNewsCount = 0;
    let todaysNewsCount = 0;

    if (req.app.locals.isConnectedToMongoDB) {
      // Force "editor" view to show only their stats, even if they are subeditor
      const newsList = await News.find({ authorId: targetEditorId }).sort({ publishedAt: -1 }).limit(12);
      totalNewsCount = await News.countDocuments({ authorId: targetEditorId });
      activeNewsCount = await News.countDocuments({ authorId: targetEditorId, isActive: true });
      inactiveNewsCount = await News.countDocuments({ authorId: targetEditorId, isActive: false });
      pendingNewsCount = await News.countDocuments({
        authorId: targetEditorId,
        isActive: false,
        'rejectionStatus.isRejected': { $ne: true }
      });

      const categories = await Category.find({ type: { $in: ['news', null] } });
      const locations = await Location.find();

      const locationMap = {};
      locations.forEach(location => {
        locationMap[location.name] = location.code;
      });

      const newsListWithCodes = newsList.map(news => {
        return {
          ...news.toObject(),
          locationCode: news.location ? locationMap[news.location] : null,
          authorRole: targetAdmin.displayRole || 'Reporter',
          authorSystemRole: targetAdmin.role || 'editor'
        };
      });

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      todaysNewsCount = await News.countDocuments({
        authorId: targetEditorId,
        publishedAt: { $gte: today }
      });

      const viewsAgg = await News.aggregate([
        { $match: { authorId: targetEditorId } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$views', 0] } } } }
      ]);
      const totalViews = viewsAgg[0]?.total || 0;

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
        admin: targetAdmin,
        isImpersonating: true
      });
    } else {
      res.status(500).send('MongoDB required for impersonation');
    }
  } catch (error) {
    console.error('Error in renderImpersonatedDashboard:', error);
    res.status(500).send('Server Error');
  }
}

// Render impersonated news list for a specific sub-editor
async function renderImpersonatedNewsList(req, res) {
  try {
    const targetEditorId = req.params.id;
    const targetAdmin = await Admin.findById(targetEditorId).lean();
    if (!targetAdmin) {
      return res.status(404).send('Editor not found');
    }
    
    targetAdmin.id = targetAdmin._id.toString();
    targetAdmin.isImpersonated = true;
    targetAdmin.impersonatorName = req.admin.name || 'Super Admin';

    // Override req.admin so newsController thinks we are the subeditor
    req.admin = targetAdmin;
    req.isImpersonating = true;
    
    // Set locals so the view knows we are impersonating
    res.locals.isImpersonating = true;

    const scopeOptions = { ignoreCanViewAllNews: true };

    // Calculate metrics for the sub-editor (including assigned reporters)
    const authorFilter = targetAdmin.role === 'subeditor'
      ? await buildSubEditorAuthorFilter(Admin, targetAdmin, scopeOptions)
      : null;
    const queryCond = authorFilter || { authorId: targetEditorId };

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    const sevenDaysAgo = new Date(todayStart);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

    res.locals.impersonationMetrics = {
      totalNews: await News.countDocuments(queryCond),
      todayNews: await News.countDocuments({ ...queryCond, publishedAt: { $gte: todayStart } }),
      yesterdayNews: await News.countDocuments({ ...queryCond, publishedAt: { $gte: yesterdayStart, $lt: todayStart } }),
      sevenDaysNews: await News.countDocuments({ ...queryCond, publishedAt: { $gte: sevenDaysAgo } }),
      pendingNews: await News.countDocuments({ ...queryCond, isActive: false, 'rejectionStatus.isRejected': { $ne: true } }),
      rejectedNews: await News.countDocuments({ ...queryCond, isActive: false, 'rejectionStatus.isRejected': true })
    };

    // Call the original news list controller function
    return newsController.renderNewsListPage(req, res);
  } catch (error) {
    console.error('Error in renderImpersonatedNewsList:', error);
    res.status(500).send('Server Error');
  }
}

// Get news count for custom date range for impersonated sub-editor
async function getImpersonatedNewsCount(req, res) {
  try {
    const targetEditorId = req.params.id;
    const { from, to } = req.query;
    
    if (!from || !to) {
      return res.status(400).json({ error: 'Missing from or to dates' });
    }

    const targetAdmin = await Admin.findById(targetEditorId).lean();
    if (!targetAdmin) {
      return res.status(404).json({ error: 'Editor not found' });
    }

    const scopeOptions = targetAdmin.role === 'subeditor'
      ? { ignoreCanViewAllNews: true }
      : {};
    const authorFilter = targetAdmin.role === 'subeditor'
      ? await buildSubEditorAuthorFilter(Admin, targetAdmin, scopeOptions)
      : null;
    const fromDate = new Date(`${from}T00:00:00.000+05:30`);
    const toDate = new Date(`${to}T23:59:59.999+05:30`);

    const queryCond = {
      ...(authorFilter || { authorId: targetEditorId }),
      publishedAt: {
        $gte: fromDate,
        $lte: toDate
      }
    };

    const count = await News.countDocuments(queryCond);
    const pendingCount = await News.countDocuments({ ...queryCond, isActive: false, 'rejectionStatus.isRejected': { $ne: true } });
    const rejectedCount = await News.countDocuments({ ...queryCond, isActive: false, 'rejectionStatus.isRejected': true });
    
    // Calculate Video and Normal News
    const videoCount = await News.countDocuments({
      $and: [
        queryCond,
        { $or: [{ mediaType: 'video' }, { videoUrl: { $ne: null, $exists: true } }] }
      ]
    });
    const normalCount = count - videoCount;

    res.json({ count, pendingCount, rejectedCount, videoCount, normalCount });
  } catch (error) {
    console.error('Error in getImpersonatedNewsCount:', error);
    res.status(500).json({ error: 'Server Error' });
  }
}

// Get report data for multiple editors including hourly activity heatmap
async function getMultiEditorReportData(req, res) {
  try {
    const { adminIds, from, to } = req.body;
    
    if (!adminIds || !Array.isArray(adminIds) || adminIds.length === 0 || !from || !to) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const reportData = [];

    for (const adminId of adminIds) {
      const targetAdmin = await Admin.findById(adminId).lean();
      if (!targetAdmin) continue;

      const scopeOptions = targetAdmin.role === 'subeditor'
        ? { ignoreCanViewAllNews: true }
        : {};
      const authorFilter = targetAdmin.role === 'subeditor'
        ? await buildSubEditorAuthorFilter(Admin, targetAdmin, scopeOptions)
        : null;
      const fromDate = new Date(`${from}T00:00:00.000+05:30`);
      const toDate = new Date(`${to}T23:59:59.999+05:30`);

      const queryCond = {
        ...(authorFilter || { authorId: adminId }),
        publishedAt: {
          $gte: fromDate,
          $lte: toDate
        }
      };

      const count = await News.countDocuments(queryCond);
      const pendingCount = await News.countDocuments({ ...queryCond, isActive: false, 'rejectionStatus.isRejected': { $ne: true } });
      const rejectedCount = await News.countDocuments({ ...queryCond, isActive: false, 'rejectionStatus.isRejected': true });
      const videoCount = await News.countDocuments({
        $and: [
          queryCond,
          { $or: [{ mediaType: 'video' }, { videoUrl: { $ne: null, $exists: true } }] }
        ]
      });
      const normalCount = count - videoCount;

      // Hourly Activity Heatmap (0-23 hours)
      const hourlyData = new Array(24).fill(0);
      try {
        const hourlyStats = await News.aggregate([
          { $match: queryCond },
          { 
            $project: { 
              hour: { $hour: { date: "$publishedAt", timezone: "Asia/Kolkata" } } 
            }
          },
          { 
            $group: { 
              _id: "$hour", 
              count: { $sum: 1 } 
            } 
          }
        ]);
        
        hourlyStats.forEach(stat => {
          if (stat._id !== null && stat._id >= 0 && stat._id < 24) {
            hourlyData[stat._id] = stat.count;
          }
        });
      } catch (err) {
        console.error('Error aggregating hourly stats:', err);
      }

      // Language Breakdown
      const languageData = {};
      try {
        const langStats = await News.aggregate([
          { $match: queryCond },
          { 
            $group: { 
              _id: "$language", 
              count: { $sum: 1 } 
            } 
          }
        ]);
        
        langStats.forEach(stat => {
          const lang = stat._id || 'Unknown';
          languageData[lang] = stat.count;
        });
      } catch (err) {
        console.error('Error aggregating language stats:', err);
      }

      reportData.push({
        id: adminId,
        name: targetAdmin.name || targetAdmin.username,
        role: targetAdmin.role,
        count,
        pendingCount,
        rejectedCount,
        videoCount,
        normalCount,
        hourlyData,
        languageData
      });
    }

    res.json({ success: true, data: reportData });
  } catch (error) {
    console.error('Error in getMultiEditorReportData:', error);
    res.status(500).json({ error: 'Server Error' });
  }
}
async function renderEditorsPage(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    // Only admins and superadmins can view editors
    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).send('Access denied. Admins only.');
    }

    // Get all editors and subeditors
    const editors = await Admin.find({ role: { $in: ['editor', 'subeditor'] } }).sort({ createdAt: -1 });

    const editorIds = editors.map(editor => editor._id.toString());

    const statsByEditor = {};
    const latestRejectByEditor = {};

    if (editorIds.length > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      weekAgo.setHours(0, 0, 0, 0);

      const lifecycleStats = await News.aggregate([
        {
          $match: {
            authorId: { $in: editorIds }
          }
        },
        {
          $group: {
            _id: '$authorId',
            submitted: { $sum: 1 },
            published: { $sum: { $cond: [{ $eq: ['$isActive', true] }, 1, 0] } },
            rejected: { $sum: { $cond: [{ $eq: ['$rejectionStatus.isRejected', true] }, 1, 0] } },
            pending: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ['$isActive', false] }, { $ne: ['$rejectionStatus.isRejected', true] }] },
                  1,
                  0
                ]
              }
            },
            todayCount: { $sum: { $cond: [{ $gte: ['$publishedAt', today] }, 1, 0] } },
            weeklyCount: { $sum: { $cond: [{ $gte: ['$publishedAt', weekAgo] }, 1, 0] } },
            totalViews: { $sum: { $ifNull: ['$views', 0] } }
          }
        }
      ]);

      // NEW: Aggregate Monthly Views for the last 6 months
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
      sixMonthsAgo.setDate(1);
      sixMonthsAgo.setHours(0, 0, 0, 0);

      const monthlyTrendData = await News.aggregate([
        {
          $match: {
            authorId: { $in: editorIds },
            publishedAt: { $gte: sixMonthsAgo }
          }
        },
        {
          $group: {
            _id: {
              authorId: "$authorId",
              year: { $year: "$publishedAt" },
              month: { $month: "$publishedAt" }
            },
            views: { $sum: { $ifNull: ["$views", 0] } },
            posts: { $sum: 1 }
          }
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } }
      ]);

      const monthlyTrendByEditor = {};
      monthlyTrendData.forEach(item => {
        if (!monthlyTrendByEditor[item._id.authorId]) monthlyTrendByEditor[item._id.authorId] = [];
        monthlyTrendByEditor[item._id.authorId].push({
          month: item._id.month,
          year: item._id.year,
          views: item.views,
          posts: item.posts
        });
      });

      lifecycleStats.forEach(item => {
        statsByEditor[item._id] = {
          submitted: item.submitted || 0,
          published: item.published || 0,
          pending: item.pending || 0,
          rejected: item.rejected || 0,
          today: item.todayCount || 0,
          weekly: item.weeklyCount || 0,
          totalViews: item.totalViews || 0,
          monthlyTrend: monthlyTrendByEditor[item._id] || []
        };
      });

      const latestRejectedNews = await News.aggregate([
        {
          $match: {
            authorId: { $in: editorIds },
            'rejectionStatus.isRejected': true
          }
        },
        {
          $sort: {
            'rejectionStatus.rejectedAt': -1
          }
        },
        {
          $group: {
            _id: '$authorId',
            reason: { $first: '$rejectionStatus.reason' },
            feedback: { $first: '$rejectionStatus.feedback' },
            rejectedAt: { $first: '$rejectionStatus.rejectedAt' }
          }
        }
      ]);

      latestRejectedNews.forEach(item => {
        latestRejectByEditor[item._id] = {
          reason: item.reason || 'Not specified',
          feedback: item.feedback || '',
          rejectedAt: item.rejectedAt || null
        };
      });
    }

    const editorsWithStats = editors.map(editor => {
      const editorObj = editor.toObject();
      return {
        ...editorObj,
        newsStats: statsByEditor[editor._id.toString()] || {
          submitted: 0,
          published: 0,
          pending: 0,
          rejected: 0,
          today: 0,
          weekly: 0,
          totalViews: 0,
          monthlyTrend: []
        },
        latestRejection: latestRejectByEditor[editor._id.toString()] || null
      };
    });

    // Fetch locations for edit dropdown
    const locations = await Location.find().sort({ name: 1 });
    const languageViewData = await getLanguageViewData();

    res.render('editors', {
      admin,
      editors: editorsWithStats,
      locations,
      ...languageViewData
    });
  } catch (error) {
    console.error('Editors page error:', error);
    res.status(500).send('Error fetching editors');
  }
}

const performanceRecommendations = [
  {
    title: 'Attention-Oriented Quality Tracking',
    detail: 'Track average views and completion quality per published story to prioritize attention over raw output.',
    source: 'Chartbeat Metrics (attention/time metrics)'
  },
  {
    title: 'Engagement + Conversion Split',
    detail: 'Separate engagement indicators (views/comments/likes) from workflow indicators (approval, rejection, pending age).',
    source: 'Hootsuite KPI framework (engagement/reach/conversion grouping)'
  },
  {
    title: 'Operational SLA Dashboard',
    detail: 'Measure turnaround time from submission to decision, and flag items pending beyond SLA.',
    source: 'Industry customer-response KPI patterns'
  },
  {
    title: 'Weekly Benchmarking Leaderboard',
    detail: 'Benchmark team members against role peers and show week-over-week movement (+/- rank).',
    source: 'Common newsroom and social analytics benchmarking practice'
  },
  {
    title: 'Quality Guardrails with Alerts',
    detail: 'Auto-alert on rejection spikes, low publish ratio, or sudden drop in audience response.',
    source: 'Data-driven editorial governance playbooks'
  }
];

const clampScore = (value) => {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
};

const classifyPerformanceBand = (score) => {
  if (score >= 75) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 45) return 'average';
  return 'poor';
};

const getSystemRoleLabel = (member) => {
  if (member.role === 'subeditor') {
    return 'Sub Editor';
  }

  const displayRole = (member.displayRole || '').toLowerCase();
  if (displayRole.includes('sub') && displayRole.includes('editor')) {
    return 'Sub Editor';
  }

  return 'Reporter';
};

async function renderPerformanceAnalyticsPage(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).send('Access denied. Admins only.');
    }

    const allowedPeriods = ['1', 'yesterday', '7', '30', '90', 'all'];
    const period = allowedPeriods.includes(req.query.period) ? req.query.period : '30';
    const { startDate, endDate } = req.query;

    let sinceDate = null;
    let untilDate = null;

    if (startDate) {
      sinceDate = new Date(startDate);
      sinceDate.setHours(0, 0, 0, 0);
    }
    if (endDate) {
      untilDate = new Date(endDate);
      untilDate.setHours(23, 59, 59, 999);
    }

    if (!startDate && period !== 'all') {
      untilDate = new Date();
      untilDate.setHours(23, 59, 59, 999);
      sinceDate = new Date();
      
      if (period === '1') {
        sinceDate.setHours(0, 0, 0, 0); // Today
      } else if (period === 'yesterday') {
        sinceDate.setDate(sinceDate.getDate() - 1);
        sinceDate.setHours(0, 0, 0, 0);
        untilDate = new Date(sinceDate);
        untilDate.setHours(23, 59, 59, 999); // Exactly yesterday
      } else {
        sinceDate.setDate(sinceDate.getDate() - parseInt(period));
        sinceDate.setHours(0, 0, 0, 0);
      }
    }

    const members = await Admin.find({ role: { $in: ['editor', 'subeditor'] } })
      .select('_id username name email role displayRole isActive lastLogin location constituency')
      .sort({ createdAt: -1 })
      .lean();

    const memberIds = members.map((member) => member._id.toString());

    const newsMatch = {
      authorId: { $in: memberIds }
    };

    if (sinceDate || untilDate) {
      newsMatch.publishedAt = {};
      if (sinceDate) newsMatch.publishedAt.$gte = sinceDate;
      if (untilDate) newsMatch.publishedAt.$lte = untilDate;
    }

    const authorStats = await News.aggregate([
      { $match: newsMatch },
      {
        $project: {
          authorId: 1,
          isActive: 1,
          views: { $ifNull: ['$views', 0] },
          likes: { $ifNull: ['$likes', 0] },
          comments: { $ifNull: ['$comments', 0] },
          isApproved: '$approvalStatus.isApproved',
          isRejected: '$rejectionStatus.isRejected'
        }
      },
      {
        $group: {
          _id: '$authorId',
          submitted: { $sum: 1 },
          published: {
            $sum: {
              $cond: [{ $eq: ['$isActive', true] }, 1, 0]
            }
          },
          rejected: {
            $sum: {
              $cond: [{ $eq: ['$isRejected', true] }, 1, 0]
            }
          },
          approved: {
            $sum: {
              $cond: [{ $eq: ['$isApproved', true] }, 1, 0]
            }
          },
          pending: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$isActive', false] },
                    { $ne: ['$isRejected', true] }
                  ]
                },
                1,
                0
              ]
            }
          },
          totalViews: { $sum: '$views' },
          totalLikes: { $sum: '$likes' },
          totalComments: { $sum: '$comments' }
        }
      }
    ]);

    // NEW: Team-wide Monthly View Trend (Last 6 Months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const teamMonthlyTrend = await News.aggregate([
      {
        $match: {
          authorId: { $in: memberIds },
          publishedAt: { $gte: sixMonthsAgo }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$publishedAt" },
            month: { $month: "$publishedAt" }
          },
          views: { $sum: { $ifNull: ["$views", 0] } }
        }
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } }
    ]);

    const normalizeName = (value) => (value || '').toString().trim().toLowerCase();

    const memberIdSet = new Set(memberIds);
    const memberNameToId = {};
    members.forEach((member) => {
      const memberId = member._id.toString();
      const usernameKey = normalizeName(member.username);
      const nameKey = normalizeName(member.name);

      if (usernameKey) {
        memberNameToId[usernameKey] = memberId;
      }
      if (nameKey) {
        memberNameToId[nameKey] = memberId;
      }
    });

    const moderationDocs = await News.find({
      $or: [
        { 'actionHistory.action': { $in: ['approved', 'rejected'] } },
        { 'approvalStatus.isApproved': true },
        { 'rejectionStatus.isRejected': true }
      ]
    })
      .select('actionHistory approvalStatus rejectionStatus')
      .lean();

    const moderationStatsMap = {};
    memberIds.forEach((id) => {
      moderationStatsMap[id] = {
        approvalsGiven: 0,
        rejectionsGiven: 0
      };
    });

    const resolveMemberId = (performedById, performedByName) => {
      const idCandidate = performedById ? performedById.toString() : '';
      if (idCandidate && memberIdSet.has(idCandidate)) {
        return idCandidate;
      }

      const nameCandidate = normalizeName(performedByName);
      if (nameCandidate && memberNameToId[nameCandidate]) {
        return memberNameToId[nameCandidate];
      }

      return null;
    };

    const isWithinPeriod = (dateValue) => {
      if (!sinceDate) return true;
      if (!dateValue) return false;
      return new Date(dateValue) >= sinceDate;
    };

    moderationDocs.forEach((doc) => {
      const history = Array.isArray(doc.actionHistory) ? doc.actionHistory : [];
      let hasApprovedHistory = false;
      let hasRejectedHistory = false;

      history.forEach((entry) => {
        if (!entry || !['approved', 'rejected'].includes(entry.action)) {
          return;
        }

        if (!isWithinPeriod(entry.performedAt)) {
          return;
        }

        const targetMemberId = resolveMemberId(entry.performedById, entry.performedByName);
        if (!targetMemberId || !moderationStatsMap[targetMemberId]) {
          return;
        }

        if (entry.action === 'approved') {
          moderationStatsMap[targetMemberId].approvalsGiven += 1;
          hasApprovedHistory = true;
        }

        if (entry.action === 'rejected') {
          moderationStatsMap[targetMemberId].rejectionsGiven += 1;
          hasRejectedHistory = true;
        }
      });

      // Backward compatibility: old records may not have actionHistory entries.
      if (!hasApprovedHistory && doc.approvalStatus?.isApproved && isWithinPeriod(doc.approvalStatus.approvedAt)) {
        const approvedMemberId = resolveMemberId(null, doc.approvalStatus.approvedBy);
        if (approvedMemberId && moderationStatsMap[approvedMemberId]) {
          moderationStatsMap[approvedMemberId].approvalsGiven += 1;
        }
      }

      if (!hasRejectedHistory && doc.rejectionStatus?.isRejected && isWithinPeriod(doc.rejectionStatus.rejectedAt)) {
        const rejectedMemberId = resolveMemberId(null, doc.rejectionStatus.rejectedBy);
        if (rejectedMemberId && moderationStatsMap[rejectedMemberId]) {
          moderationStatsMap[rejectedMemberId].rejectionsGiven += 1;
        }
      }
    });

    const authorStatsMap = {};
    authorStats.forEach((item) => {
      authorStatsMap[item._id] = item;
    });

    // moderationStatsMap is already prepared above with strong fallback handling.

    const analyticsRows = members.map((member) => {
      const id = member._id.toString();
      const stats = authorStatsMap[id] || {};
      const moderation = moderationStatsMap[id] || {};

      const submitted = stats.submitted || 0;
      const published = stats.published || 0;
      const pending = stats.pending || 0;
      const rejected = stats.rejected || 0;
      const approved = stats.approved || 0;
      const totalViews = stats.totalViews || 0;
      const totalLikes = stats.totalLikes || 0;
      const totalComments = stats.totalComments || 0;
      const approvalsGiven = moderation.approvalsGiven || 0;
      const rejectionsGiven = moderation.rejectionsGiven || 0;

      const publishRate = submitted > 0 ? (published / submitted) * 100 : 0;
      const rejectionRate = submitted > 0 ? (rejected / submitted) * 100 : 0;
      const avgViews = published > 0 ? totalViews / published : 0;
      const avgEngagement = published > 0 ? (totalLikes + totalComments) / published : 0;
      const moderationLoad = approvalsGiven + rejectionsGiven;

      const qualityScore = clampScore(publishRate - (rejectionRate * 0.35));
      const engagementScore = clampScore((avgViews / 200) * 100);
      const outputScore = clampScore((submitted / 20) * 100);
      const moderationScore = clampScore((moderationLoad / 40) * 100);

      const systemRole = getSystemRoleLabel(member);
      const isSubEditor = systemRole === 'Sub Editor';
      const moderationApproved = isSubEditor ? approvalsGiven : approved;
      const moderationRejected = isSubEditor ? rejectionsGiven : rejected;
      const moderationLabel = isSubEditor ? 'Handled' : 'Received';

      const performanceScore = isSubEditor
        ? clampScore((qualityScore * 0.35) + (moderationScore * 0.35) + (engagementScore * 0.15) + (outputScore * 0.15))
        : clampScore((qualityScore * 0.5) + (engagementScore * 0.3) + (outputScore * 0.2));

      return {
        id,
        name: member.name || member.username,
        username: member.username,
        email: member.email,
        isActive: member.isActive,
        role: systemRole,
        location: member.location || '-',
        constituency: member.constituency || '-',
        lastLogin: member.lastLogin || null,
        submitted,
        published,
        pending,
        rejected,
        totalViews,
        avgViews: Number(avgViews.toFixed(1)),
        avgEngagement: Number(avgEngagement.toFixed(1)),
        publishRate: Number(publishRate.toFixed(1)),
        rejectionRate: Number(rejectionRate.toFixed(1)),
        approvalsGiven,
        rejectionsGiven,
        moderationApproved,
        moderationRejected,
        moderationLabel,
        moderationLoad,
        performanceScore: Number(performanceScore.toFixed(1)),
        performanceBand: classifyPerformanceBand(performanceScore)
      };
    });

    analyticsRows.sort((a, b) => b.performanceScore - a.performanceScore);

    const rowsWithRank = analyticsRows.map((row, index) => ({
      ...row,
      rank: index + 1
    }));

    const subEditors = rowsWithRank.filter((row) => row.role === 'Sub Editor');
    const reporters = rowsWithRank.filter((row) => row.role === 'Reporter');

    const topPerformers = rowsWithRank.slice(0, 5);
    const poorPerformers = [...rowsWithRank].reverse().slice(0, 5).reverse();

    const totalTeamViews = rowsWithRank.reduce((acc, row) => acc + row.totalViews, 0);

    const summary = {
      totalMembers: rowsWithRank.length,
      totalSubEditors: subEditors.length,
      totalReporters: reporters.length,
      totalTeamViews: totalTeamViews,
      excellentCount: rowsWithRank.filter((row) => row.performanceBand === 'excellent').length,
      poorCount: rowsWithRank.filter((row) => row.performanceBand === 'poor').length,
      avgScore: rowsWithRank.length > 0
        ? Number((rowsWithRank.reduce((acc, row) => acc + row.performanceScore, 0) / rowsWithRank.length).toFixed(1))
        : 0
    };

    const searchQuery = (req.query.search || '').trim();
    const roleFilter = ['reporter', 'subeditor'].includes(req.query.role) ? req.query.role : '';
    const bandFilter = ['excellent', 'good', 'average', 'poor'].includes(req.query.band) ? req.query.band : '';
    const selectedAuthorId = (req.query.authorId || '').trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(10, parseInt(req.query.limit, 10) || 15));

    let filteredRows = rowsWithRank;

    if (selectedAuthorId) {
      filteredRows = filteredRows.filter((row) => row.id === selectedAuthorId);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filteredRows = filteredRows.filter((row) =>
        (row.name || '').toLowerCase().includes(q) ||
        (row.username || '').toLowerCase().includes(q) ||
        (row.email || '').toLowerCase().includes(q) ||
        (row.location || '').toLowerCase().includes(q)
      );
    }
    if (roleFilter === 'reporter') {
      filteredRows = filteredRows.filter((row) => row.role === 'Reporter');
    } else if (roleFilter === 'subeditor') {
      filteredRows = filteredRows.filter((row) => row.role === 'Sub Editor');
    }
    if (bandFilter) {
      filteredRows = filteredRows.filter((row) => row.performanceBand === bandFilter);
    }

    const totalFiltered = filteredRows.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / limit));
    const safePage = Math.min(page, totalPages);
    const paginatedRows = filteredRows.slice((safePage - 1) * limit, safePage * limit);

    const filterCounts = {
      all: rowsWithRank.length,
      reporters: rowsWithRank.filter((row) => row.role === 'Reporter').length,
      subeditors: rowsWithRank.filter((row) => row.role === 'Sub Editor').length
    };

    const selectedMember = selectedAuthorId
      ? rowsWithRank.find((row) => row.id === selectedAuthorId) || null
      : null;

    return res.render('performance-analytics', {
      admin,
      title: 'Performance Analytics',
      period,
      sinceDate,
      untilDate,
      startDate: req.query.startDate || '',
      endDate: req.query.endDate || '',
      searchQuery,
      roleFilter,
      bandFilter,
      selectedAuthorId,
      selectedMember,
      summary,
      filterCounts,
      analyticsRows: paginatedRows,
      topPerformers,
      poorPerformers,
      teamMonthlyTrend,
      recommendations: performanceRecommendations,
      pagination: {
        currentPage: safePage,
        limit,
        totalRows: totalFiltered,
        totalPages
      }
    });
  } catch (error) {
    console.error('Performance analytics page error:', error);
    return res.status(500).send('Error loading performance analytics');
  }
}

// Update editor (PUT /editors/:id)
async function updateEditor(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Only admins and superadmins can update editors
    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Admins only.' });
    }

    const editorId = req.params.id;
    const { name, username, displayRole, location, assignedLocations, assignedState, assignedStates, assignedDistricts, assignedConstituencies, allowedScopes, allowedLanguages, constituency, mobileNumber, role, profileImage, workingLanguage, displaySettings, canViewReporterDetails, canAccessAdminDashboard, canApproveNews, canViewAllNews, canSendNotifications, sidebar, approvalScope, managedLocations, managedStates, managedDistricts, managedConstituencies, managedReporterIds } = req.body;

    const editor = await Admin.findById(editorId);
    if (!editor || (editor.role !== 'editor' && editor.role !== 'subeditor')) {
      return res.status(404).json({ error: 'Editor not found' });
    }

    // Super admin only: change login username
    if (username !== undefined) {
      if (admin.role !== 'superadmin') {
        return res.status(403).json({ error: 'Only super admin can change username.' });
      }
      const nextUsername = String(username || '').trim();
      if (!nextUsername) {
        return res.status(400).json({ error: 'Username cannot be empty.' });
      }
      const previousUsername = (editor.username || '').trim();
      // Same as create flow — no character-class restriction.
      // Only run uniqueness when the value actually changes.
      if (nextUsername !== previousUsername) {
        if (nextUsername.length < 2) {
          return res.status(400).json({ error: 'Username must be at least 2 characters.' });
        }
        const taken = await Admin.findOne({
          username: nextUsername,
          _id: { $ne: editor._id }
        });
        if (taken) {
          return res.status(400).json({ error: 'Username already taken. Choose another.' });
        }
        editor.username = nextUsername;
        try {
          const { logAudit } = require('../utils/auditLogger');
          logAudit({
            req,
            action: 'editor_username_update',
            entityType: 'Admin',
            entityId: editor._id.toString(),
            targetId: editor._id,
            targetName: editor.name || nextUsername,
            description: `Username changed from "${previousUsername}" to "${nextUsername}"`,
            before: { username: previousUsername },
            after: { username: nextUsername }
          });
        } catch (e) { /* audit optional */ }
      }
    }

    // Update fields
    if (name !== undefined) editor.name = name || null;
    if (displayRole !== undefined) editor.displayRole = displayRole || 'Reporter';
    if (location !== undefined) editor.location = location || null;
    applyReporterCoverageFields(editor, {
      assignedStates, assignedState, assignedDistricts, assignedConstituencies,
      assignedLocations, constituency
    });
    if (constituency !== undefined) editor.constituency = constituency || null;
    if (allowedScopes !== undefined) {
      editor.allowedScopes = Array.isArray(allowedScopes) ? allowedScopes : [];
    }
    if (allowedLanguages !== undefined) {
      if (editor.role === 'subeditor') {
        editor.allowedLanguages = Array.isArray(allowedLanguages)
          ? allowedLanguages.map(l => normalizeNewsLanguage(l)).filter(Boolean)
          : [];
        if (editor.allowedLanguages.length && !editor.allowedLanguages.includes('all')) {
          editor.workingLanguage = editor.allowedLanguages[0];
        }
      } else {
        editor.allowedLanguages = [];
      }
    }
    if (mobileNumber !== undefined) editor.mobileNumber = mobileNumber || null;
    if (profileImage !== undefined) editor.profileImage = profileImage || null;
    if (workingLanguage !== undefined) editor.workingLanguage = normalizeNewsLanguage(workingLanguage);

    if (displaySettings !== undefined) {
      if (!editor.displaySettings) editor.displaySettings = { showProfileImage: true, showName: true, showConstituency: true };
      
      if (displaySettings.showProfileImage !== undefined) {
        editor.displaySettings.showProfileImage = displaySettings.showProfileImage === 'true' || displaySettings.showProfileImage === true;
      }
      if (displaySettings.showName !== undefined) {
        editor.displaySettings.showName = displaySettings.showName === 'true' || displaySettings.showName === true;
      }
      if (displaySettings.showConstituency !== undefined) {
        editor.displaySettings.showConstituency = displaySettings.showConstituency === 'true' || displaySettings.showConstituency === true;
      }
    }

    if (canViewReporterDetails !== undefined || canAccessAdminDashboard !== undefined || canApproveNews !== undefined || canViewAllNews !== undefined) {
      if (!editor.permissions) editor.permissions = {};
      if (canViewReporterDetails !== undefined) {
        editor.permissions.canViewReporterDetails = canViewReporterDetails === 'true' || canViewReporterDetails === true;
      }
      if (canAccessAdminDashboard !== undefined) {
        editor.permissions.canAccessAdminDashboard = canAccessAdminDashboard === 'true' || canAccessAdminDashboard === true;
      }
      if (canApproveNews !== undefined) {
        editor.permissions.canApproveNews = canApproveNews === 'true' || canApproveNews === true;
      }
      if (canViewAllNews !== undefined) {
        editor.permissions.canViewAllNews = canViewAllNews === 'true' || canViewAllNews === true;
      }
    }
    
    if (approvalScope !== undefined || managedLocations !== undefined || managedStates !== undefined ||
        managedDistricts !== undefined || managedConstituencies !== undefined || managedReporterIds !== undefined) {
      if (!editor.permissions) editor.permissions = {};
      applySubEditorCoveragePermissions(editor, {
        approvalScope, managedLocations, managedStates, managedDistricts,
        managedConstituencies, managedReporterIds
      });
    }
    if (req.body.canSendNotifications !== undefined) {
      if (!editor.permissions) editor.permissions = {};
      editor.permissions.canSendNotifications = req.body.canSendNotifications === 'true' || req.body.canSendNotifications === true;
    }
    if (req.body.canEditNews !== undefined) {
      if (!editor.permissions) editor.permissions = {};
      editor.permissions.canEditNews = req.body.canEditNews === 'true' || req.body.canEditNews === true;
    }
    if (req.body.requiresSourceLink !== undefined) {
      if (!editor.permissions) editor.permissions = {};
      editor.permissions.requiresSourceLink = req.body.requiresSourceLink === 'true' || req.body.requiresSourceLink === true;
    }
    
    if (sidebar !== undefined) {
      if (!editor.permissions) editor.permissions = {};
      if (!editor.permissions.sidebar) editor.permissions.sidebar = {};
      
      const sidebarFields = ['dashboard', 'newsList', 'addNews', 'pendingNews', 'rejectedNews', 'plagiarismReport', 'viralVideos', 'polls', 'longVideos', 'categories', 'programCategories', 'locations', 'reports', 'zodiac'];
      
      sidebarFields.forEach(field => {
        if (sidebar[field] !== undefined) {
            editor.permissions.sidebar[field] = sidebar[field] === 'true' || sidebar[field] === true;
        }
      });
    }

    // Update role if provided (only allow editor or subeditor)
    if (role !== undefined && (role === 'editor' || role === 'subeditor')) {
      editor.role = role;
    }

    // Per-reporter wallet & daily earnings config
    if (req.body.walletConfig !== undefined) {
      const wc = req.body.walletConfig || {};
      const before = {
        enabled: editor.walletConfig?.enabled === true,
        dailyTargetNews: editor.walletConfig?.dailyTargetNews ?? null,
        dailyRewardAmount: editor.walletConfig?.dailyRewardAmount ?? null
      };
      if (!editor.walletConfig) editor.walletConfig = {};
      if (wc.enabled !== undefined) {
        editor.walletConfig.enabled = wc.enabled === 'true' || wc.enabled === true;
      }
      const target = Number(wc.dailyTargetNews);
      editor.walletConfig.dailyTargetNews = (Number.isFinite(target) && target > 0) ? Math.round(target) : null;
      const reward = Number(wc.dailyRewardAmount);
      editor.walletConfig.dailyRewardAmount = (Number.isFinite(reward) && reward > 0) ? Math.round(reward) : null;

      const after = {
        enabled: editor.walletConfig.enabled,
        dailyTargetNews: editor.walletConfig.dailyTargetNews,
        dailyRewardAmount: editor.walletConfig.dailyRewardAmount
      };
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        try {
          const { logAudit } = require('../utils/auditLogger');
          logAudit({
            req,
            action: 'wallet_config_update',
            entityType: 'Admin',
            entityId: editor._id.toString(),
            targetId: editor._id,
            targetName: editor.name || editor.username,
            description: `Wallet config updated for ${editor.name || editor.username}`,
            before,
            after
          });
        } catch (e) { /* audit optional */ }
      }
    }

    await editor.save();

    res.json({
      message: 'Editor updated successfully',
      editor: {
        _id: editor._id,
        username: editor.username,
        name: editor.name,
        role: editor.role,
        displayRole: editor.displayRole,
        location: editor.location,
        constituency: editor.constituency,
        mobileNumber: editor.mobileNumber,
        displaySettings: editor.displaySettings,
        permissions: editor.permissions
      }
    });
  } catch (error) {
    console.error('Update editor error:', error);
    if (error && error.code === 11000) {
      return res.status(400).json({ error: 'Username already taken. Choose another.' });
    }
    res.status(500).json({ error: 'An error occurred while updating editor' });
  }
}

// Toggle editor active status (PUT /editors/:id/status)
async function toggleEditorStatus(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Admins only.' });
    }

    const editorId = req.params.id;
    const { isActive } = req.body;

    const editor = await Admin.findById(editorId);
    if (!editor || (editor.role !== 'editor' && editor.role !== 'subeditor')) {
      return res.status(404).json({ error: 'Editor not found' });
    }

    const nextStatus = typeof isActive === 'boolean' ? isActive : !editor.isActive;

    if (editorId === req.admin.id && nextStatus === false) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }

    editor.isActive = nextStatus;
    await editor.save();

    return res.json({
      message: `Editor ${editor.isActive ? 'activated' : 'deactivated'} successfully`,
      editor: {
        _id: editor._id,
        isActive: editor.isActive
      }
    });
  } catch (error) {
    console.error('Toggle editor status error:', error);
    return res.status(500).json({ error: 'An error occurred while updating status' });
  }
}

// Change editor password (PUT /editors/:id/password)
async function changeEditorPassword(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Admins only.' });
    }

    const editorId = req.params.id;
    const { newPassword } = req.body;

    if (!newPassword || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'New password is required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const editor = await Admin.findById(editorId);
    if (!editor || (editor.role !== 'editor' && editor.role !== 'subeditor')) {
      return res.status(404).json({ error: 'Editor not found' });
    }

    editor.password = newPassword;
    await editor.save();

    return res.json({ message: 'Editor password updated successfully' });
  } catch (error) {
    console.error('Change editor password error:', error);
    res.status(500).json({ error: 'An error occurred while updating password' });
  }
}

// Get editor stats for a specific range (AJAX API)
async function getEditorRangeStats(req, res) {
  try {
    const { authorId, startDate, endDate } = req.query;

    if (!authorId || !startDate || !endDate) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    console.log(`Fetching stats for Editor: ${authorId} from ${start} to ${end}`);

    const count = await News.countDocuments({
      authorId: authorId,
      publishedAt: { $gte: start, $lte: end }
    });

    console.log(`Count found: ${count}`);
    res.json({ count });
  } catch (error) {
    console.error('Get editor range stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}


// Delete editor (DELETE /editors/:id)
async function deleteEditor(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Only admins and superadmins can delete editors
    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Admins only.' });
    }

    const editorId = req.params.id;

    // Prevent deleting self
    if (editorId === req.admin.id) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const editor = await Admin.findById(editorId);
    if (!editor || (editor.role !== 'editor' && editor.role !== 'subeditor')) {
      return res.status(404).json({ error: 'Editor not found' });
    }

    await Admin.findByIdAndDelete(editorId);

    // Also remove their news author name reference or handle differently if needed
    // For now, we just delete the account

    res.json({ message: 'Editor deleted successfully' });
  } catch (error) {
    console.error('Delete editor error:', error);
    res.status(500).json({ error: 'An error occurred while deleting editor' });
  }
}
// Render register editor page
async function renderRegisterEditorPage(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    // Only admins and superadmins can register editors
    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).send('Access denied. Admins only.');
    }

    // Fetch locations for dropdown
    const locations = await Location.find().sort({ name: 1 });
    const languageViewData = await getLanguageViewData();

    res.render('register-editor', { admin, locations, ...languageViewData });
  } catch (error) {
    console.error('Register editor page error:', error);
    res.status(500).send('Error loading register editor page');
  }
}

// Register new editor
async function registerEditor(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Only admins and superadmins can register editors
    if (admin.role !== 'admin' && admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Admins only.' });
    }

    const { username, email, password, name, displayRole, location, assignedLocations, assignedState, assignedStates, assignedDistricts, assignedConstituencies, allowedScopes, allowedLanguages, constituency, mobileNumber, role, workingLanguage, canViewReporterDetails, canAccessAdminDashboard, canApproveNews, canViewAllNews, canEditNews, requiresSourceLink, canSendNotifications, approvalScope, managedLocations, managedStates, managedDistricts, managedConstituencies, managedReporterIds, sidebar } = req.body;

    // Validate required fields
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    // Validate role - only allow editor or subeditor
    const allowedRoles = ['editor', 'subeditor'];
    const selectedRole = allowedRoles.includes(role) ? role : 'editor';

    // Check if username or email already exists
    const existingUser = await Admin.findOne({ $or: [{ username }, { email }] });
    if (existingUser) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    // Create new editor
    const newEditor = new Admin({
      username,
      email,
      password, // Password will be hashed by pre-save hook
      role: selectedRole,
      name: name || null,
      displayRole: displayRole || (selectedRole === 'subeditor' ? 'Sub-Editor' : 'Reporter'),
      location: location || null,
      constituency: constituency || null,
      assignedStates: [],
      assignedDistricts: [],
      assignedConstituencies: [],
      assignedLocations: [],
      allowedScopes: Array.isArray(allowedScopes) ? allowedScopes : (allowedScopes ? [allowedScopes] : []),
      allowedLanguages: Array.isArray(allowedLanguages)
        ? allowedLanguages.map(l => normalizeNewsLanguage(l)).filter(Boolean)
        : [],
      mobileNumber: mobileNumber || null,
      workingLanguage: normalizeNewsLanguage(workingLanguage),
      permissions: {
        canViewReporterDetails: canViewReporterDetails === 'true' || canViewReporterDetails === true,
        canAccessAdminDashboard: canAccessAdminDashboard === 'true' || canAccessAdminDashboard === true,
        canApproveNews: canApproveNews === 'true' || canApproveNews === true,
        canViewAllNews: canViewAllNews === 'true' || canViewAllNews === true,
        canEditNews: canEditNews === 'true' || canEditNews === true,
        requiresSourceLink: requiresSourceLink === 'true' || requiresSourceLink === true,
        canSendNotifications: canSendNotifications === 'true' || canSendNotifications === true,
        approvalScope: approvalScope || 'reporters',
        managedStates: [],
        managedDistricts: [],
        managedConstituencies: [],
        managedReporterIds: [],
        managedLocations: [],
        sidebar: sidebar ? {
            dashboard: sidebar.dashboard === 'true' || sidebar.dashboard === true,
            newsList: sidebar.newsList === 'true' || sidebar.newsList === true,
            addNews: sidebar.addNews === 'true' || sidebar.addNews === true,
            pendingNews: sidebar.pendingNews === 'true' || sidebar.pendingNews === true,
            rejectedNews: sidebar.rejectedNews === 'true' || sidebar.rejectedNews === true,
            plagiarismReport: sidebar.plagiarismReport === 'true' || sidebar.plagiarismReport === true,
            viralVideos: sidebar.viralVideos === 'true' || sidebar.viralVideos === true,
            polls: sidebar.polls === 'true' || sidebar.polls === true,
            longVideos: sidebar.longVideos === 'true' || sidebar.longVideos === true,
            categories: sidebar.categories === 'true' || sidebar.categories === true,
            programCategories: sidebar.programCategories === 'true' || sidebar.programCategories === true,
            locations: sidebar.locations === 'true' || sidebar.locations === true,
            reports: sidebar.reports === 'true' || sidebar.reports === true,
            zodiac: sidebar.zodiac === 'true' || sidebar.zodiac === true
        } : undefined
      },
      createdBy: admin._id
    });

    applyReporterCoverageFields(newEditor, {
      assignedStates, assignedState, assignedDistricts, assignedConstituencies,
      assignedLocations, constituency
    });
    applySubEditorCoveragePermissions(newEditor, {
      approvalScope, managedLocations, managedStates, managedDistricts,
      managedConstituencies, managedReporterIds
    });

    if (selectedRole === 'subeditor' && newEditor.allowedLanguages?.length && !newEditor.allowedLanguages.includes('all')) {
      newEditor.workingLanguage = newEditor.allowedLanguages[0];
    }

    await newEditor.save();

    res.status(201).json({
      message: 'Editor registered successfully',
      editor: {
        id: newEditor._id,
        username: newEditor.username,
        email: newEditor.email,
        role: newEditor.role
      }
    });
  } catch (error) {
    console.error('Register editor error:', error);
    res.status(500).json({ error: 'An error occurred while registering editor' });
  }
}

// Render reports page
async function renderReportsPage(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    res.render('reports', { admin });
  } catch (error) {
    console.error('Reports page error:', error);
    res.status(500).send('Error fetching reports');
  }
}

// Send notification to all connected clients
async function sendNotification(req, res) {
  try {
    const { title, message, newsId, imageUrl, launchUrl, titleColor, messageColor, titleFontSize, platformSettings, priority, language } = req.body;

    // Validate input
    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }
    
    // Check permissions
    if (req.admin.role === 'subeditor') {
        if (!req.admin.permissions || !req.admin.permissions.canSendNotifications) {
            return res.status(403).json({ error: 'You do not have permission to send notifications.' });
        }
    }

    const plainTitle = title;
    const plainMessage = message ? message : '\u200B'; // Zero-width space for OneSignal if empty

    let targetLanguage = language ? normalizeNewsLanguage(language) : null;
    let linkedNewsItem = null;

    console.log('📧 Notification - Original:', title);
    console.log('📧 Notification - Title Color:', titleColor);

    // ⏳ SERVER LOAD CONTROL: Restrict push notifications within 2 minutes of publishing news
    // To prevent mass simultaneous operations (WebSocket + Database + Cache + Push)
    if (newsId) {
      try {
        linkedNewsItem = await News.findById(newsId).lean();

        if (linkedNewsItem && !targetLanguage) {
          targetLanguage = normalizeNewsLanguage(linkedNewsItem.language);
        }

        let referenceDate = linkedNewsItem?.publishedAt;
        if (linkedNewsItem && linkedNewsItem.approvalStatus && linkedNewsItem.approvalStatus.approvedAt) {
          const pubTime = new Date(linkedNewsItem.publishedAt).getTime();
          const appTime = new Date(linkedNewsItem.approvalStatus.approvedAt).getTime();
          referenceDate = new Date(Math.max(pubTime, appTime));
        }
        
        if (linkedNewsItem && referenceDate) {
          const timeSincePublished = Date.now() - new Date(referenceDate).getTime();
          const twoMinutesMs = 2 * 60 * 1000;
          
          if (timeSincePublished < twoMinutesMs) {
            const remainingSeconds = Math.ceil((twoMinutesMs - timeSincePublished) / 1000);
            return res.status(429).json({ 
              error: `సర్వర్ లోడ్ కంట్రోల్: దయచేసి రిఫ్రెష్ పేజీలో వార్త పబ్లిష్ లేదా అప్రూవ్ చేసిన 2 నిమిషాల తర్వాత మాత్రమే పుష్ నోటిఫికేషన్ పంపండి. ఇంకా ${remainingSeconds} సెకన్లు వేచి ఉండండి.` 
            });
          }
        }
      } catch (err) {
        console.error('Error checking news publishedAt time for notification cooldown:', err);
      }
    }

    if (!targetLanguage) {
      targetLanguage = getDefaultLanguageCode();
    }

    console.log(`🌐 Push notification target language: ${targetLanguage}`);

    // If newsId is provided but launchUrl is not, automatically set the launch URL to the news detail page
    let finalLaunchUrl = launchUrl;
    if (newsId && !launchUrl) {
      // Set default launch URL to point to the news detail page
      finalLaunchUrl = `/news/${newsId}`;
    }

    // Set default small icon if not provided
    let finalPlatformSettings = platformSettings || {};
    if (!finalPlatformSettings.android) {
      finalPlatformSettings.android = {};
    }
    if (!finalPlatformSettings.android.icon) {
      // Use the OneSignal default icon
      finalPlatformSettings.android.icon = 'ic_stat_onesignal_default';
    }

    // Ensure LED settings are properly configured
    if (finalPlatformSettings.android.lights !== undefined) {
      if (finalPlatformSettings.android.lights) {
        // If LED is enabled, ensure timing is set
        if (finalPlatformSettings.android.ledOnMs === undefined) {
          finalPlatformSettings.android.ledOnMs = 1000;
        }
        if (finalPlatformSettings.android.ledOffMs === undefined) {
          finalPlatformSettings.android.ledOffMs = 1000;
        }
      }
    }

    // Get io instance from app locals
    const io = req.app.locals.io;
    const connectedClients = req.app.locals.connectedClients;

    if (!io) {
      return res.status(500).json({ error: 'WebSocket server not initialized' });
    }

    // Get all users to track recipients
    let allUsers = [];
    if (req.app.locals.isConnectedToMongoDB) {
      allUsers = await User.find({}, '_id');
    }

    // Prepare notification data
    const notificationData = {
      title: plainTitle,      // 🎨 Use plain text (HTML stripped)
      message: plainMessage,  // 🎨 Use plain text (HTML stripped)
      newsId: newsId || null,
      imageUrl: imageUrl || null,
      launchUrl: finalLaunchUrl || null,
      titleColor: titleColor || null, // Include title color in WebSocket notification
      messageColor: messageColor || null, // Include message color
      titleFontSize: titleFontSize || 'normal', // Include title font size
      platformSettings: finalPlatformSettings,
      priority: priority || 'normal',
      language: targetLanguage,
      timestamp: new Date()
    };

    // Emit to all connected clients (manual admin push — use admin_notification only)
    io.emit('admin_notification', notificationData);

    // If newsId provided, emit news_published for consumer app refresh — NOT new_news
    // (new_news is reserved for reporter pending submissions → admin pending toast)
    if (newsId) {
      try {
        const newsDetails = linkedNewsItem || await News.findById(newsId).lean();
        if (newsDetails) {
          const newsNotificationData = {
            id: newsDetails._id,
            title: newsDetails.title,
            content: newsDetails.content,
            category: newsDetails.category,
            location: newsDetails.location,
            publishedAt: newsDetails.publishedAt,
            author: newsDetails.author,
            mediaType: newsDetails.mediaType,
            mediaUrl: newsDetails.mediaUrl,
            thumbnailUrl: newsDetails.thumbnailUrl,
            imageUrl: newsDetails.imageUrl || newsDetails.mediaUrl
          };

          const { emitPublished } = require('../services/realtime/workflowEmit');
          emitPublished(io, newsNotificationData);
        }
      } catch (newsError) {
        console.error('⚠️ Error fetching news details for WebSocket:', newsError);
      }
    }

    // Send OneSignal notification
    try {
      await oneSignalService.sendAdminNotification(plainTitle, plainMessage, {
        newsId: newsId || null,
        imageUrl: imageUrl || null,
        launchUrl: finalLaunchUrl || null,
        titleColor: titleColor || '#FF6F00',  // Default orange if not provided
        messageColor: messageColor || '#333333', // Default dark gray
        titleFontSize: titleFontSize || 'normal', // Pass the selected font size
        platformSettings: finalPlatformSettings,
        priority: priority || 'normal',
        language: targetLanguage,
        ...notificationData
      });
      console.log(`OneSignal admin notification sent to news_language=${targetLanguage}`);
    } catch (error) {
      console.error('Error sending OneSignal admin notification:', error);
    }

    // Create recipients list from connected clients
    const recipients = [];
    if (connectedClients) {
      for (let [userId, socketId] of connectedClients.entries()) {
        recipients.push({
          userId: userId,
          received: true, // Since we're sending now, mark as received
          receivedAt: new Date(),
          opened: false
        });
      }
    }

    // Add users who are not connected but exist in the database
    for (const user of allUsers) {
      const userId = user._id.toString();
      if (!recipients.find(r => r.userId === userId)) {
        recipients.push({
          userId: userId,
          received: false,
          opened: false
        });
      }
    }

    // Save notification to database
    const notification = new Notification({
      title,
      message,
      type: 'admin',
      priority: priority || 'normal',
      newsId: newsId || null,
      imageUrl: imageUrl || null,
      recipients: recipients,
      sentBy: req.admin.username,
      sentAt: new Date()
    });

    if (req.app.locals.isConnectedToMongoDB) {
      await notification.save();
      // Add the ID to the notification data sent to clients
      notificationData.id = notification._id;
    }

    res.json({
      message: `Notification sent to ${targetLanguage} language users`,
      targetLanguage,
      notification: notificationData
    });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: 'Error sending notification' });
  }
}

// Get notification statistics with enhanced data
async function getNotificationStats(req, res) {
  try {
    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const totalNotifications = await Notification.countDocuments();

    const stats = await Notification.aggregate([
      {
        $group: {
          _id: '$priority',
          count: { $sum: 1 }
        }
      }
    ]);

    const priorityStats = {
      normal: 0,
      high: 0,
      urgent: 0
    };

    stats.forEach(stat => {
      priorityStats[stat._id] = stat.count;
    });

    // Get recent notifications (last 7 days)
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const recentNotifications = await Notification.find({
      sentAt: { $gte: oneWeekAgo }
    }).sort({ sentAt: -1 }).limit(5);

    // Get delivery statistics
    const deliveryStats = await Notification.aggregate([
      {
        $project: {
          totalRecipients: { $size: "$recipients" },
          openedRecipients: {
            $size: {
              $filter: {
                input: "$recipients",
                cond: "$$this.opened"
              }
            }
          },
          receivedRecipients: {
            $size: {
              $filter: {
                input: "$recipients",
                cond: "$$this.received"
              }
            }
          }
        }
      },
      {
        $group: {
          _id: null,
          totalRecipients: { $sum: "$totalRecipients" },
          totalOpened: { $sum: "$openedRecipients" },
          totalReceived: { $sum: "$receivedRecipients" }
        }
      }
    ]);

    const deliveryInfo = deliveryStats.length > 0 ? deliveryStats[0] : {
      totalRecipients: 0,
      totalOpened: 0,
      totalReceived: 0
    };

    res.json({
      total: totalNotifications,
      priorityStats,
      recentNotifications,
      deliveryStats: deliveryInfo
    });
  } catch (error) {
    console.error('Error fetching notification stats:', error);
    res.status(500).json({ error: 'Error fetching notification stats' });
  }
}

// Get notification by ID
async function getNotificationById(req, res) {
  try {
    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const notification = await Notification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json(notification);
  } catch (error) {
    console.error('Error fetching notification:', error);
    res.status(500).json({ error: 'Error fetching notification' });
  }
}

// Get notification history with pagination and filtering
async function getNotificationHistory(req, res) {
  try {
    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    // Get notifications with pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Build filter query
    const filter = {};

    // Add type filter if provided
    if (req.query.type) {
      filter.type = req.query.type;
    }

    // Add priority filter if provided
    if (req.query.priority) {
      filter.priority = req.query.priority;
    }

    // Add date range filter if provided
    if (req.query.startDate || req.query.endDate) {
      filter.sentAt = {};
      if (req.query.startDate) {
        filter.sentAt.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        filter.sentAt.$lte = new Date(req.query.endDate);
      }
    }

    const notifications = await Notification.find(filter)
      .sort({ sentAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Notification.countDocuments(filter);

    res.json({
      notifications,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching notification history:', error);
    res.status(500).json({ error: 'Error fetching notification history' });
  }
}

// Get recent notifications (last 5)
async function getRecentNotifications(req, res) {
  try {
    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    // Get recent notifications (last 5)
    const recentNotifications = await Notification.find()
      .sort({ sentAt: -1 })
      .limit(5);

    res.json({
      recentNotifications
    });
  } catch (error) {
    console.error('Error fetching recent notifications:', error);
    res.status(500).json({ error: 'Error fetching recent notifications' });
  }
}

// Mark notification as opened by user
async function markNotificationOpened(req, res) {
  try {
    const { notificationId } = req.body;
    const userId = req.admin.id; // Assuming admin ID, but this should be user ID in real implementation

    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const notification = await Notification.findById(notificationId);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    // Find the recipient and mark as opened
    const recipient = notification.recipients.find(r => r.userId === userId);
    if (recipient) {
      recipient.opened = true;
      recipient.openedAt = new Date();

      await notification.save();

      res.json({ message: 'Notification marked as opened' });
    } else {
      res.status(404).json({ error: 'Recipient not found' });
    }
  } catch (error) {
    console.error('Error marking notification as opened:', error);
    res.status(500).json({ error: 'Error marking notification as opened' });
  }
}

// Mark notification as received by user (for real-time tracking)
async function markNotificationReceived(req, res) {
  try {
    const { notificationId, userId } = req.body;

    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const notification = await Notification.findById(notificationId);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    // Find the recipient and mark as received
    const recipient = notification.recipients.find(r => r.userId === userId);
    if (recipient) {
      // If already marked as opened, don't change that
      // But we can track when it was received
      if (!recipient.receivedAt) {
        recipient.receivedAt = new Date();
        await notification.save();
      }

      res.json({ message: 'Notification marked as received' });
    } else {
      res.status(404).json({ error: 'Recipient not found' });
    }
  } catch (error) {
    console.error('Error marking notification as received:', error);
    res.status(500).json({ error: 'Error marking notification as received' });
  }
}

// Render notifications page with history
async function renderNotificationsPage(req, res) {
  try {
    // Check permissions
    if (req.admin.role === 'subeditor') {
        if (!req.admin.permissions || !req.admin.permissions.canSendNotifications) {
            return res.status(403).send('You do not have permission to view this page.');
        }
    }
    
    // Get notification stats
    let stats = {
      total: 0,
      priorityStats: { normal: 0, high: 0, urgent: 0 },
      recentNotifications: [],
      deliveryStats: {
        totalRecipients: 0,
        totalOpened: 0,
        totalReceived: 0
      }
    };

    if (req.app.locals.isConnectedToMongoDB) {
      const totalNotifications = await Notification.countDocuments();

      const notificationStats = await Notification.aggregate([
        {
          $group: {
            _id: '$priority',
            count: { $sum: 1 }
          }
        }
      ]);

      stats.priorityStats = {
        normal: 0,
        high: 0,
        urgent: 0
      };

      notificationStats.forEach(stat => {
        stats.priorityStats[stat._id] = stat.count;
      });

      stats.total = totalNotifications;

      // Get recent notifications (last 5)
      stats.recentNotifications = await Notification.find()
        .sort({ sentAt: -1 })
        .limit(5);

      // Get delivery statistics
      const deliveryStats = await Notification.aggregate([
        {
          $project: {
            totalRecipients: { $size: "$recipients" },
            openedRecipients: {
              $size: {
                $filter: {
                  input: "$recipients",
                  cond: "$$this.opened"
                }
              }
            },
            receivedRecipients: {
              $size: {
                $filter: {
                  input: "$recipients",
                  cond: "$$this.received"
                }
              }
            }
          }
        },
        {
          $group: {
            _id: null,
            totalRecipients: { $sum: "$totalRecipients" },
            totalOpened: { $sum: "$openedRecipients" },
            totalReceived: { $sum: "$totalReceived" }
          }
        }
      ]);

      stats.deliveryStats = deliveryStats.length > 0 ? deliveryStats[0] : {
        totalRecipients: 0,
        totalOpened: 0,
        totalReceived: 0
      };
    }

    res.render('notifications', {
      admin: req.admin,
      stats: stats
    });
  } catch (error) {
    console.error('Error rendering notifications page:', error);
    res.status(500).json({ error: 'Error rendering notifications page' });
  }
}

// Render OneSignal Analytics page
async function renderOneSignalAnalyticsPage(req, res) {
  try {
    res.render('onesignal-analytics', {
      admin: req.admin
    });
  } catch (error) {
    console.error('Error rendering OneSignal analytics page:', error);
    res.status(500).json({ error: 'Error rendering OneSignal analytics page' });
  }
}

// Authentication middleware

/** Reporter-allowed paths when dashboard access is revoked (exact prefix match; no substring). */
function isReporterAllowedPath(originalUrl) {
  const path = String(originalUrl || '').split('?')[0];
  if (path === '/news/api/news' || path.startsWith('/news/api/news/')) return true;
  if (path === '/news/upload-media' || path.startsWith('/news/upload-media/')) return true;
  // Reporter wallet/profile APIs under /admin (must not match /admin/api/news or reporter-applications)
  if (path.startsWith('/admin/api/reporter/')) return true;
  return false;
}

const requireAuth = (req, res, next) => {
  let token = req.cookies?.token;

  // Check Authorization header if cookie is missing
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  // Check if this is an API request (based on content type or accept header)
  const isApiRequest = req.path.startsWith('/api/') ||
    req.path.includes('/upload-') ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    (req.headers['content-type'] && req.headers['content-type'].includes('application/json'));

  if (!token) {
    if (isApiRequest) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    
    // Fetch latest admin data to ensure permissions are up to date
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    if (isConnectedToMongoDB) {
        Admin.findById(decoded.id).select('permissions isActive role').then(latestAdmin => {
            if (!latestAdmin || !latestAdmin.isActive) {
                res.clearCookie('token');
                if (isApiRequest) return res.status(401).json({ error: 'Session expired or account deactivated' });
                return res.redirect('/login');
            }
            
            // Check if role was changed to reporter, or if subeditor lost dashboard access
            const hasDashboardAccess = latestAdmin.role === 'superadmin' || latestAdmin.role === 'admin' || 
                (latestAdmin.role === 'subeditor' && latestAdmin.permissions?.canAccessAdminDashboard);
            
            const isReporterAppApi = isReporterAllowedPath(req.originalUrl);

            if (!hasDashboardAccess && !isReporterAppApi) {
                res.clearCookie('token');
                if (isApiRequest) return res.status(403).json({ error: 'Access revoked' });
                return res.redirect('/login');
            }
            
            decoded.role = latestAdmin.role;
            decoded.permissions = latestAdmin.permissions || {};
            req.admin = decoded;
            res.locals.admin = decoded;
            next();
        }).catch(() => {
            res.clearCookie('token');
            if (isApiRequest) {
              return res.status(401).json({ error: 'Authentication failed' });
            }
            return res.redirect('/login');
        });
    } else {
        req.admin = decoded;
        res.locals.admin = decoded;
        next();
    }
  } catch (error) {
    if (isApiRequest) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    res.redirect('/login');
  }
};

// Check if admin is super admin
const requireSuperAdmin = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());

    if (decoded.role !== 'superadmin') {
      return res.status(403).send('Access denied. Super admin only.');
    }

    req.admin = decoded;
    res.locals.admin = decoded;
    next();
  } catch (error) {
    res.redirect('/login');
  }
};

/** Block sub-editors unless Super Admin granted sidebar access to this menu. */
const requireSidebarMenu = (menu) => (req, res, next) => {
  if (!req.admin) {
    const isApiRequest = req.path.startsWith('/api/') ||
      (req.headers.accept && req.headers.accept.includes('application/json'));
    if (isApiRequest) return res.status(401).json({ error: 'Unauthorized' });
    return res.redirect('/login');
  }

  if (canAccessSidebarMenu(req.admin, menu)) {
    return next();
  }

  const isApiRequest = req.path.startsWith('/api/') ||
    (req.headers.accept && req.headers.accept.includes('application/json'));
  if (isApiRequest) {
    return res.status(403).json({ error: 'Access denied. You do not have permission for this feature.' });
  }
  return res.status(403).send('Access denied. You do not have permission to access this page.');
};

// Check if user is admin or superadmin
const requireAdmin = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());

    if (decoded.role !== 'admin' && decoded.role !== 'superadmin') {
      return res.status(403).send('Access denied. Admins only.');
    }

    req.admin = decoded;
    res.locals.admin = decoded;
    next();
  } catch (error) {
    res.redirect('/login');
  }
};

// Check if user is editor
const requireEditor = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());

    if (decoded.role !== 'editor') {
      return res.status(403).send('Access denied. Editors only.');
    }

    req.admin = decoded;
    res.locals.admin = decoded;
    next();
  } catch (error) {
    res.redirect('/login');
  }
};

// Delete notification by ID
async function deleteNotification(req, res) {
  try {
    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const notification = await Notification.findByIdAndDelete(req.params.id);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.json({ message: 'Notification deleted successfully' });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ error: 'Error deleting notification' });
  }
}

// Delete all notification history
async function deleteAllNotifications(req, res) {
  try {
    if (!req.app.locals.isConnectedToMongoDB) {
      return res.status(500).json({ error: 'Database not connected' });
    }

    const result = await Notification.deleteMany({});

    res.json({
      message: `Successfully deleted ${result.deletedCount} notifications`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error deleting all notifications:', error);
    res.status(500).json({ error: 'Error deleting all notifications' });
  }
}

// Get OneSignal analytics
async function getOneSignalAnalytics(req, res) {
  try {
    // Get app details
    let appDetails = null;
    try {
      appDetails = await oneSignalService.getAppDetails();
    } catch (error) {
      console.error('Error getting OneSignal app details:', error);
    }

    // Get recent notifications from OneSignal
    let recentNotifications = null;
    try {
      recentNotifications = await oneSignalService.getNotifications(10, 0);
    } catch (error) {
      console.error('Error getting OneSignal notifications:', error);
    }

    res.json({
      appDetails,
      recentNotifications
    });
  } catch (error) {
    console.error('Error fetching OneSignal analytics:', error);
    res.status(500).json({ error: 'Error fetching OneSignal analytics' });
  }
}

// Get user details by ID
async function getUserById(req, res) {
  try {
    const id = req.params.id;
    let user;

    // Check if it's a valid MongoDB ObjectId (must be 24 hex characters)
    if (mongoose.Types.ObjectId.isValid(id) && /^[0-9a-fA-F]{24}$/.test(id)) {
      try {
        user = await User.findById(id);
      } catch (err) {
        console.log('Not a valid ObjectId reference despite check:', id);
      }
    }

    // If not found by ObjectId, treat as Google ID
    if (!user) {
      user = await User.findOne({ googleId: id });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Normalize data for frontend
    const userData = {
      _id: user.googleId || user._id, // Prefer Google ID for consistency if available
      username: user.displayName,
      email: user.email,
      phone: user.phone || user.mobileNumber || 'Not provided',
      profilePic: user.photoUrl || user.profilePic || '/images/default-avatar.png',
      createdAt: user.createdAt,
      userType: user.googleId ? 'Google User' : 'Standard User',
      deviceFingerprint: user.deviceFingerprint || 'Unknown',
      referralCode: user.referralCode || 'None'
    };

    res.json(userData);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Error fetching user details' });
  }
}

// Render R2 Usage Page
async function renderR2UsagePage(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) {
      return res.redirect('/login');
    }

    const axios = require('axios');
    const moment = require('moment');

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      return res.render('r2-usage', {
        admin,
        error: 'Cloudflare credentials not configured',
        usageData: null,
        activePage: 'r2-usage',
        currentStorage: 0,
        classAOps: 0,
        classBOps: 0,
        estimatedCost: 0,
        dailyOps: {},
        dailyStorage: {}
      });
    }

    // Prepare GraphQL query for R2 usage
    const query = `
      query GetR2Usage($accountId: String!, $opsFilter: AccountR2OperationsAdaptiveGroupsFilter_InputObject!, $storageFilter: AccountR2StorageAdaptiveGroupsFilter_InputObject!) {
        viewer {
          accounts(filter: { accountTag: $accountId }) {
            r2OperationsAdaptiveGroups(
              limit: 1000
              filter: $opsFilter
              orderBy: [datetime_ASC]
            ) {
              dimensions {
                datetime
                actionType
              }
              sum {
                requests
              }
            }
            r2StorageAdaptiveGroups(
              limit: 1000
              filter: $storageFilter
              orderBy: [datetime_ASC]
            ) {
              dimensions {
                datetime
              }
              max {
                payloadSize
              }
            }
          }
        }
      }
    `;

    const now = moment();
    const startDate = moment().subtract(28, 'days').format('YYYY-MM-DDTHH:mm:ssZ'); // Max 4 weeks allowed by Cloudflare
    const endDate = now.format('YYYY-MM-DDTHH:mm:ssZ');

    const variables = {
      accountId: accountId,
      opsFilter: {
        datetime_geq: startDate,
        datetime_leq: endDate
      },
      storageFilter: {
        datetime_geq: startDate,
        datetime_leq: endDate
      }
    };

    let response;
    try {
      response = await axios({
        url: 'https://api.cloudflare.com/client/v4/graphql',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        data: {
          query,
          variables
        }
      });

      if (response.data.errors) {
        console.error('Cloudflare GraphQL Errors:', response.data.errors);
        // Check if it's an authorization error
        const isAuthError = response.data.errors.some(err => err.message.toLowerCase().includes('not authorized') || err.extensions?.code === 'authz');

        return res.render('r2-usage', {
          admin,
          error: isAuthError ? 'Cloudflare API Token lacks "Account Analytics" permissions. Please update your token.' : 'Cloudflare API error',
          usageData: null,
          activePage: 'r2-usage',
          currentStorage: 0,
          classAOps: 0,
          classBOps: 0,
          estimatedCost: 0,
          dailyOps: {},
          dailyStorage: {}
        });
      }
    } catch (apiError) {
      console.error('Cloudflare API Request Failed:', apiError.message);
      return res.render('r2-usage', {
        admin,
        error: `Cloudflare connection failed: ${apiError.message}`,
        usageData: null,
        activePage: 'r2-usage',
        currentStorage: 0,
        classAOps: 0,
        classBOps: 0,
        estimatedCost: 0,
        dailyOps: {},
        dailyStorage: {}
      });
    }

    const account = response.data.data.viewer.accounts[0];
    const opsData = account.r2OperationsAdaptiveGroups || [];
    const storageData = account.r2StorageAdaptiveGroups || [];

    // Process Operations
    let classAOps = 0;
    let classBOps = 0;
    const dailyOps = {};

    opsData.forEach(group => {
      const date = moment(group.dimensions.datetime).format('YYYY-MM-DD');
      const action = (group.dimensions.actionType || '').toLowerCase();
      const requests = group.sum.requests || 0;

      if (!dailyOps[date]) dailyOps[date] = { a: 0, b: 0 };

      if (['putobject', 'copyobject', 'listobjects', 'completeMultipartUpload', 'createMultipartUpload', 'uploadpart'].some(a => action.includes(a.toLowerCase()))) {
        classAOps += requests;
        dailyOps[date].a += requests;
      } else {
        classBOps += requests;
        dailyOps[date].b += requests;
      }
    });

    // Process Storage
    const dailyStorage = {};
    let currentStorage = 0;
    storageData.forEach(group => {
      const date = moment(group.dimensions.datetime).format('YYYY-MM-DD');
      const sizeGB = ((group.max && group.max.payloadSize) || 0) / (1024 * 1024 * 1024);
      dailyStorage[date] = sizeGB;
      currentStorage = sizeGB;
    });

    // Cost Estimation
    const freeStorage = 10;
    const freeClassA = 1000000;
    const freeClassB = 10000000;

    const billableStorage = Math.max(0, currentStorage - freeStorage);
    const billableClassA = Math.max(0, classAOps - freeClassA);
    const billableClassB = Math.max(0, classBOps - freeClassB);

    const estimatedCost = (billableStorage * 0.015) +
      (billableClassA / 1000000 * 4.50) +
      (billableClassB / 1000000 * 0.36);

    res.render('r2-usage', {
      admin,
      activePage: 'r2-usage',
      currentStorage: currentStorage.toFixed(4),
      classAOps,
      classBOps,
      estimatedCost: estimatedCost.toFixed(2),
      dailyOps,
      dailyStorage,
      error: null
    });

  } catch (error) {
    console.error('R2 Usage render error:', error);
    res.status(500).send('Error loading R2 usage dashboard');
  }
}

// Reporter/Editor API Login (for mobile/Next.js apps)
async function reporterLogin(req, res) {
  try {
    const trimmedUsername = (req.body.username || '').trim();
    const trimmedPassword = (req.body.password || '').trim();

    // Validate input
    if (!trimmedUsername || !trimmedPassword) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Find admin/editor by username or email
    const admin = await Admin.findByUsernameOrEmail(trimmedUsername);

    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if account is active
    if (!admin.isActive) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }

    // Only allow editors and subeditors to login via reporter app
    if (!['editor', 'subeditor', 'admin', 'superadmin'].includes(admin.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Compare password
    const isMatch = await admin.comparePassword(trimmedPassword);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: admin._id,
        username: admin.username,
        role: admin.role
      },
      getJwtSecret(),
      { expiresIn: '7d' }
    );

    // Return user data and token
    res.json({
      message: 'Login successful',
      token,
      user: {
        id: admin._id,
        username: admin.username,
        email: admin.email,
        role: admin.role,
        name: admin.name,
        displayRole: admin.displayRole,
        location: admin.location,
        profileImage: admin.profileImage
      }
    });
  } catch (error) {
    console.error('Reporter login error:', error);
    res.status(500).json({ error: 'An error occurred during login' });
  }
}

// Get reporter profile
async function getReporterProfile(req, res) {
  try {
    const admin = await Admin.findById(req.admin.id).select('-password -loginHistory');
    if (!admin) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: admin._id,
        username: admin.username,
        email: admin.email,
        role: admin.role,
        name: admin.name,
        displayRole: admin.displayRole,
        location: admin.location,
        constituency: admin.constituency,
        mobileNumber: admin.mobileNumber,
        profileImage: admin.profileImage,
        walletEnabled: admin.walletConfig?.enabled === true
      }
    });
  } catch (error) {
    console.error('Get reporter profile error:', error);
    res.status(500).json({ error: 'An error occurred' });
  }
}

// Render pending news page for editors to review
// ⚡ OPTIMIZED: No duplicate check at render time — page loads instantly
// Duplicate check happens lazily via /admin/api/pending-news/duplicate-check
async function renderPendingNewsPage(req, res) {
  try {
    const adminDoc = await Admin.findById(req.admin.id).select('role workingLanguage permissions').lean();

    let selectedLanguage = '';
    const languageParamProvided = Object.prototype.hasOwnProperty.call(req.query, 'language');

    if (!languageParamProvided) {
      if (adminDoc?.role === 'subeditor' && adminDoc?.workingLanguage) {
        selectedLanguage = adminDoc.workingLanguage;
      }
    } else if (req.query.language === 'all') {
      selectedLanguage = '';
    } else {
      selectedLanguage = req.query.language || '';
    }

    const baseTeamQuery = {
      isActive: false,
      aiStatus: 'none',
      authorId: { $ne: String(req.admin.id) },
      $or: [
        { 'rejectionStatus.isRejected': { $ne: true } },
        { rejectionStatus: { $exists: false } }
      ]
    };

    let teamQuery = selectedLanguage
      ? { $and: [baseTeamQuery, buildNewsLanguageFilter(selectedLanguage)] }
      : baseTeamQuery;

    teamQuery = await buildPendingNewsFilterForSubEditor(Admin, adminDoc, teamQuery);

    const teamPendingNewsRaw = await News.find(teamQuery)
      .select('_id title content category location language author authorId publishedAt mediaUrl mediaType thumbnailUrl imageUrl imageUrls readFullLink ePaperLink views duplicateCheck revisionStatus actionHistory aiStatus')
      .sort({ publishedAt: -1 })
      .limit(100)
      .lean();

    const myPendingQuery = {
      isActive: false,
      authorId: String(req.admin.id),
      aiStatus: { $in: ['processing', 'review_required', 'failed'] },
      $or: [
        { 'rejectionStatus.isRejected': { $ne: true } },
        { rejectionStatus: { $exists: false } }
      ]
    };

    const myPendingNewsRaw = await News.find(myPendingQuery)
      .select('_id title content category location language author authorId publishedAt mediaUrl mediaType thumbnailUrl imageUrl imageUrls readFullLink ePaperLink views duplicateCheck revisionStatus actionHistory aiStatus')
      .lean();

    // Sort My AI Queue by priority, then newest first
    const priorityMap = { 'review_required': 1, 'failed': 2, 'processing': 3 };
    myPendingNewsRaw.sort((a, b) => {
      const pA = priorityMap[a.aiStatus] || 99;
      const pB = priorityMap[b.aiStatus] || 99;
      if (pA !== pB) return pA - pB;
      const dateA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const dateB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return dateB - dateA;
    });

    const allNews = [...teamPendingNewsRaw, ...myPendingNewsRaw];
    const authorIds = [...new Set(allNews.map(n => n.authorId).filter(Boolean))];
    const authors = await Admin.find({ _id: { $in: authorIds } }).select('name email mobileNumber constituency').lean();
    const authorMap = {};
    authors.forEach(a => authorMap[a._id.toString()] = a);

    const mapNewsWithDefaults = (newsArray) => newsArray.map(article => {
      let revisionStatus = article.revisionStatus || null;
      if (revisionStatus && revisionStatus.revisionSnapshot) {
        const { revisionSnapshot, ...rest } = revisionStatus;
        revisionStatus = rest;
      }
      return {
        ...article,
        revisionStatus,
        authorDetails: article.authorId ? authorMap[article.authorId.toString()] : null,
        duplicateCheck: normalizeDuplicateCheck(article.duplicateCheck),
      };
    });

    const { getDisplayConfigMap } = require('../services/languageRegistry');

    res.render('pending-news', {
      teamPendingNews: mapNewsWithDefaults(teamPendingNewsRaw),
      myPendingNews: mapNewsWithDefaults(myPendingNewsRaw),
      title: 'Pending News Review',
      selectedLanguage,
      admin: req.admin,
      adminRole: adminDoc?.role || req.admin.role,
      displayConfigByLanguage: getDisplayConfigMap(),
      ...(await getLanguageViewData())
    });
  } catch (error) {
    console.error('Error rendering pending news page:', error);
    res.status(500).send('Error loading pending news');
  }
}

// ⚡ Lazy duplicate check API — refreshes stale/missing checks and persists to DB
async function getPendingNewsDuplicateCheck(req, res) {
  try {
    const pendingNews = await News.find({
      isActive: false,
      $or: [
        { 'rejectionStatus.isRejected': { $ne: true } },
        { rejectionStatus: { $exists: false } }
      ]
    })
      .select(
        '_id title content language mediaUrl mediaType imageUrls thumbnailUrl videoUrl duplicateCheck mediaFingerprint'
      )
      .sort({ publishedAt: -1 })
      .limit(100)
      .lean();

    if (!pendingNews || pendingNews.length === 0) {
      return res.json({ success: true, results: [] });
    }

    const { scheduleMediaFingerprint } = require('../services/aiDuplicate/scheduleMediaFingerprint');

    for (const article of pendingNews) {
      const fp = article.mediaFingerprint || {};
      if (
        articleHasMedia(article) &&
        fp.status !== 'ready' &&
        fp.status !== 'pending'
      ) {
        scheduleMediaFingerprint(article);
      }
    }

    const recheckIds = pendingNews
      .filter((article) => pendingNeedsAiRecheck(article))
      .map((article) => article._id);

    const rechecked = new Map();
    const concurrency = 3;
    for (let i = 0; i < recheckIds.length; i += concurrency) {
      const batch = recheckIds.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async (id) => {
          const dc = await applyPendingDuplicateCheckViaAi(id);
          return [String(id), normalizeDuplicateCheck(dc)];
        })
      );
      for (const [id, dc] of batchResults) {
        rechecked.set(id, dc);
      }
    }

    const results = pendingNews.map((article) => {
      const id = article._id.toString();
      return {
        newsId: id,
        duplicateCheck:
          rechecked.get(id) || normalizeDuplicateCheck(article.duplicateCheck)
      };
    });

    res.set('Cache-Control', 'no-store');
    res.json({ success: true, results });
  } catch (error) {
    console.error('Error in lazy duplicate check:', error);
    res.status(500).json({ success: false, error: 'Duplicate check failed' });
  }
}

// Full duplicate match details for side-by-side review modal
async function getPendingNewsDuplicateMatches(req, res) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid news ID' });
    }

    const pendingArticle = await News.findById(id)
      .select('_id title content author category location language publishedAt isActive rejectionStatus mediaUrl mediaType imageUrl imageUrls thumbnailUrl videoUrl')
      .lean();

    if (!pendingArticle) {
      return res.status(404).json({ success: false, error: 'Article not found' });
    }

    if (pendingArticle.isActive) {
      return res.status(400).json({ success: false, error: 'Only pending articles can be compared here' });
    }

    if (pendingArticle.rejectionStatus?.isRejected) {
      return res.status(400).json({ success: false, error: 'Rejected articles cannot be compared here' });
    }

    const pendingLang = (pendingArticle.language || 'te').toLowerCase();

    const { contentHash, duplicateCheck: storedCheck } = await runDuplicateCheckGateway(
      {
        title: pendingArticle.title,
        content: pendingArticle.content,
        language: pendingLang,
        mediaUrl: pendingArticle.mediaUrl || '',
        mediaType: pendingArticle.mediaType || '',
        imageUrls: Array.isArray(pendingArticle.imageUrls)
          ? pendingArticle.imageUrls
          : [],
        thumbnailUrl: pendingArticle.thumbnailUrl || '',
        videoUrl: pendingArticle.videoUrl || ''
      },
      {
        excludeId: pendingArticle._id,
        includePendingCorpus: true
      }
    );

    await News.findByIdAndUpdate(pendingArticle._id, {
      duplicateCheck: storedCheck,
      contentHash
    });

    const { enrichSimilarArticlesFromDb } = require('../services/aiDuplicate/enrichSimilarArticles');
    const enrichedMatches = await enrichSimilarArticlesFromDb(
      storedCheck.similarArticles || []
    );

    const duplicateCheck = normalizeDuplicateCheck({
      ...storedCheck,
      similarArticles: enrichedMatches,
      matchCount: enrichedMatches.length
    });

    // Persist enriched metadata so cards/modal stay consistent
    await News.findByIdAndUpdate(pendingArticle._id, {
      duplicateCheck
    });

    const pendingMedia =
      pendingArticle.mediaUrl ||
      pendingArticle.imageUrl ||
      pendingArticle.thumbnailUrl ||
      (Array.isArray(pendingArticle.imageUrls) && pendingArticle.imageUrls[0]) ||
      null;

    res.json({
      success: true,
      pendingArticle: {
        id: pendingArticle._id,
        title: pendingArticle.title,
        content: pendingArticle.content,
        author: pendingArticle.author,
        category: pendingArticle.category,
        location: pendingArticle.location,
        language: pendingArticle.language,
        publishedAt: pendingArticle.publishedAt,
        mediaUrl: pendingMedia,
        thumbnailUrl: pendingArticle.thumbnailUrl || pendingMedia,
        imageUrls: Array.isArray(pendingArticle.imageUrls)
          ? pendingArticle.imageUrls.filter(Boolean)
          : [],
        mediaType: pendingArticle.mediaType || null,
        isActive: false,
        publishStatus: 'not_published',
      },
      duplicateCheck
    });
  } catch (error) {
    console.error('Error fetching pending duplicate matches:', error);
    res.status(500).json({ success: false, error: 'Failed to load duplicate matches' });
  }
}

// Update pending news before approval
async function updatePendingNews(req, res) {
  try {
    const { id } = req.params;
    const {
      title,
      content,
      category,
      location,
      readFullLink,
      ePaperLink
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid news ID' });
    }

    const adminId = req.adminId || req.userId || req.admin?.id || req.admin?._id?.toString();
    if (!adminId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const admin = await Admin.findById(adminId).select('username role permissions displayRole').lean();
    if (!admin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (
      admin.role !== 'superadmin' &&
      admin.role !== 'admin' &&
      admin.role !== 'subeditor'
    ) {
      return res.status(403).json({
        error: 'Only admins and authorized subeditors can update pending news.',
      });
    }
    if (
      admin.role === 'subeditor' &&
      (!admin.permissions || !admin.permissions.canApproveNews)
    ) {
      return res.status(403).json({
        error: 'You do not have permission to update pending news.',
      });
    }

    const existingNews = await News.findById(id).lean();
    if (!existingNews) {
      return res.status(404).json({ error: 'News not found' });
    }

    if (existingNews.isActive) {
      return res.status(400).json({ error: 'Only pending news can be edited from this page' });
    }

    if (existingNews.rejectionStatus?.isRejected) {
      return res.status(400).json({ error: 'Rejected news cannot be edited from pending page' });
    }

    if (existingNews.revisionStatus?.needsRevision === true) {
      return res.status(409).json({
        error: 'News is in Needs Revision. Wait for reporter resubmit or refresh.',
      });
    }

    const normalizedTitle = normalizeNewsContent(title || '');
    const normalizedContent = normalizeNewsContent(content || '');
    const normalizedCategory = (category || '').trim();
    const normalizedLocation = typeof location === 'string' ? location.trim() : '';

    if (!normalizedTitle || !normalizedContent || !normalizedCategory) {
      return res.status(400).json({ error: 'Title, content and category are required' });
    }

    await refreshLanguageCache();
    const limits = getDisplayConfigForCode(existingNews.language || 'te');
    if (stripTags(normalizedTitle).length > limits.titleMax) {
      return res.status(400).json({ error: `Title must be ${limits.titleMax} characters or less` });
    }

    if (stripTags(normalizedContent).length > limits.contentMax) {
      return res.status(400).json({ error: `Content must be ${limits.contentMax} characters or less` });
    }

    const updatePayload = {
      title: normalizedTitle,
      content: normalizedContent,
      category: normalizedCategory,
      location: normalizedLocation,
      readFullLink: typeof readFullLink === 'string' ? readFullLink.trim() : '',
      ePaperLink: typeof ePaperLink === 'string' ? ePaperLink.trim() : ''
    };

    const changedFields = [];
    ['title', 'content', 'category', 'location', 'readFullLink', 'ePaperLink'].forEach((field) => {
      const prevVal = (existingNews[field] || '').toString();
      const nextVal = (updatePayload[field] || '').toString();
      if (prevVal !== nextVal) {
        changedFields.push(field);
      }
    });

    const adminName = admin.username || req.admin?.username || req.admin?.name || 'Editor';

    let adminRole = 'Editor';
    if (admin.role === 'superadmin' || admin.role === 'admin') {
      adminRole = 'Admin';
    } else if (admin.role === 'subeditor' || admin.role === 'sub_editor') {
      adminRole = 'Sub Editor';
    } else if (admin.role === 'editor') {
      adminRole = admin.displayRole || 'Reporter';
    }

    const actionHistory = Array.isArray(existingNews.actionHistory) ? [...existingNews.actionHistory] : [];
    actionHistory.push(
      buildAdminNewsHistory(
        'updated',
        adminId,
        adminName,
        adminRole,
        changedFields.length > 0
          ? `Pending news corrected before approval (${changedFields.join(', ')})`
          : 'Pending news saved before approval',
        { changedFields }
      )
    );

    const updatedNews = await News.findOneAndUpdate(
      {
        _id: id,
        isActive: { $ne: true },
        'rejectionStatus.isRejected': { $ne: true },
        'revisionStatus.needsRevision': { $ne: true },
      },
      {
        ...updatePayload,
        actionHistory
      },
      { new: true }
    ).lean();

    if (!updatedNews) {
      return res.status(409).json({
        error: 'News state changed. Refresh and try again.',
      });
    }

    if (changedFields.includes('title') || changedFields.includes('content')) {
      await applyPendingDuplicateCheckViaAi(id);
    }

    const freshNews = await News.findById(id).lean();

    return res.json({
      success: true,
      message: 'Pending news updated successfully',
      news: freshNews || updatedNews
    });
  } catch (error) {
    console.error('Error updating pending news:', error);
    return res.status(500).json({ error: 'Failed to update pending news' });
  }
}

// Approve pending news
async function approveNews(req, res) {
  try {
    const { id } = req.params;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid news ID' });
    }

    // Get admin/editor name and role
    const adminId = req.adminId || req.userId || req.admin?.id || req.admin?._id?.toString();
    let adminName = 'Editor';
    let adminRole = 'Editor';

    if (adminId) {
      const admin = await Admin.findById(adminId).select('username role permissions').lean();
      if (!admin) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (
        admin.role !== 'superadmin' &&
        admin.role !== 'admin' &&
        admin.role !== 'subeditor'
      ) {
        return res.status(403).json({
          error: 'Only admins and authorized subeditors can approve news.',
        });
      }
      if (admin.role === 'subeditor' && (!admin.permissions || !admin.permissions.canApproveNews)) {
        return res.status(403).json({ error: 'You do not have permission to approve news' });
      }
      adminName = admin.username;
      // Format role for display
      if (admin.role === 'superadmin' || admin.role === 'admin') {
        adminRole = 'Admin';
      } else if (admin.role === 'subeditor' || admin.role === 'sub_editor') {
        adminRole = 'Sub Editor';
      } else {
        adminRole = admin.role ? admin.role.charAt(0).toUpperCase() + admin.role.slice(1) : 'Editor';
      }
    } else {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const existingNews = await News.findById(id).lean();
    if (!existingNews) {
      return res.status(404).json({ error: 'News not found' });
    }

    if (existingNews.isActive === true) {
      return res.status(400).json({ error: 'News is already published.' });
    }
    if (existingNews.rejectionStatus?.isRejected) {
      return res.status(400).json({ error: 'Rejected news cannot be approved.' });
    }

    // Language Mismatch Check
    if (!req.body.ignoreLanguageWarning) {
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

    const actionHistory = Array.isArray(existingNews.actionHistory) ? [...existingNews.actionHistory] : [];
    actionHistory.push(
      buildAdminNewsHistory(
        'approved',
        adminId,
        adminName,
        adminRole,
        'News approved and moved to active state',
        { fromStatus: existingNews.isActive, toStatus: true }
      )
    );

    // Atomic approve: only if still pending (not published / not rejected)
    const updatedNews = await News.findOneAndUpdate(
      {
        _id: id,
        isActive: { $ne: true },
        'rejectionStatus.isRejected': { $ne: true },
      },
      {
        isActive: true,
        aiStatus: 'verified',
        publishedAt: new Date(), // Refresh timestamp on approval so it becomes "latest"
        approvalStatus: {
          isApproved: true,
          approvedBy: adminName,
          approvedByRole: adminRole,
          approvedAt: new Date()
        },
        // Clear open revision lock if any (reject remains separate)
        'revisionStatus.needsRevision': false,
        actionHistory
      },
      { new: true }
    );

    if (!updatedNews) {
      return res.status(409).json({
        error: 'News state changed. Refresh and try again.',
      });
    }

    // 🔄 IMPORTANT: Clear cache FIRST, THEN emit WebSocket
    // Telugu: WebSocket emit చేయడానికి ముందు cache clear చేయాలి
    try {
      await clearCache('cache:/api/public/news*');
      await clearCache('cache:/api/public/locations*');
      await invalidateCache('graphql:news:*');
      console.log('🗂️ Cache cleared before WebSocket notification (approval)');
    } catch (cacheError) {
      console.log('⚠️ Cache clearing failed (non-critical):', cacheError.message);
    }

    // 🐦 X-STYLE IN-APP NOTIFICATION: WebSocket event for instant app notification
    const io = req.app.locals.io;
    if (io) {
      const notificationData = {
        id: updatedNews._id,
        title: updatedNews.title,
        content: updatedNews.content,
        category: updatedNews.category,
        location: updatedNews.location,
        publishedAt: updatedNews.publishedAt,
        author: updatedNews.author,
        mediaType: updatedNews.mediaType,
        mediaUrl: updatedNews.mediaUrl,
        thumbnailUrl: updatedNews.thumbnailUrl,
        imageUrl: updatedNews.imageUrl || updatedNews.mediaUrl,
        isApproved: true
      };

      const {
        emitPublished,
        emitWorkflowPair,
      } = require('../services/realtime/workflowEmit');
      emitPublished(io, notificationData);
      emitWorkflowPair(
        io,
        updatedNews.authorId,
        {
          id: updatedNews._id,
          authorId: updatedNews.authorId,
          status: 'approved',
          approvalStatus: updatedNews.approvalStatus,
        },
        {
          id: updatedNews._id,
          authorId: updatedNews.authorId,
          status: 'approved',
          title: updatedNews.title,
        }
      );
    }

    if (existingNews.authorId) {
       const { checkAndCreditWallet } = require('../utils/walletHelpers');
       checkAndCreditWallet(existingNews.authorId).catch(err => console.error(err));
    }

    res.json({
      success: true,
      message: 'News approved and published!',
      news: updatedNews
    });
  } catch (error) {
    console.error('Error approving news:', error);
    res.status(500).json({ error: 'Failed to approve news' });
  }
}

// Reject pending news
async function rejectNews(req, res) {
  try {
    const { id } = req.params;
    const { reason, feedback } = req.body;

    // Validate reason and feedback
    if (!reason || reason === 'Not specified') {
      return res.status(400).json({ error: 'Please select a rejection reason.' });
    }
    if (!feedback || feedback.trim() === '') {
      return res.status(400).json({ error: 'Please provide feedback for the rejection.' });
    }

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid news ID' });
    }

    // Get admin/editor name and role
    const adminId = req.adminId || req.userId || req.admin?.id || req.admin?._id?.toString();
    let adminName = 'Editor';
    let adminRole = 'Editor';

    if (adminId) {
      const admin = await Admin.findById(adminId).select('username role permissions').lean();
      if (!admin) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (
        admin.role !== 'superadmin' &&
        admin.role !== 'admin' &&
        admin.role !== 'subeditor'
      ) {
        return res.status(403).json({
          error: 'Only admins and authorized subeditors can reject news.',
        });
      }
      if (admin.role === 'subeditor' && (!admin.permissions || !admin.permissions.canApproveNews)) {
        return res.status(403).json({ error: 'You do not have permission to reject news.' });
      }
      adminName = admin.username;
      if (admin.role === 'superadmin' || admin.role === 'admin') {
        adminRole = 'Admin';
      } else if (admin.role === 'subeditor' || admin.role === 'sub_editor') {
        adminRole = 'Sub Editor';
      } else {
        adminRole = admin.role ? admin.role.charAt(0).toUpperCase() + admin.role.slice(1) : 'Editor';
      }
    } else {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const existingNews = await News.findById(id).lean();
    if (!existingNews) {
      return res.status(404).json({ error: 'News not found' });
    }

    const actionHistory = Array.isArray(existingNews.actionHistory) ? [...existingNews.actionHistory] : [];
    actionHistory.push(
      buildAdminNewsHistory(
        'rejected',
        adminId,
        adminName,
        adminRole,
        `News rejected${reason ? `: ${reason}` : ''}`,
        {
          reason: reason || 'Not Specified',
          feedback: feedback || 'No additional feedback',
          fromStatus: existingNews.isActive,
          toStatus: false
        }
      )
    );

    // Atomic reject: only while still pending / not already rejected
    const rejectedNews = await News.findOneAndUpdate(
      {
        _id: id,
        isActive: { $ne: true },
        'rejectionStatus.isRejected': { $ne: true },
      },
      {
        isActive: false,
        rejectionStatus: {
          isRejected: true,
          reason: reason || 'Not Specified',
          feedback: feedback || 'No additional feedback',
          rejectedBy: adminName,
          rejectedByRole: adminRole,
          rejectedAt: new Date()
        },
        'revisionStatus.needsRevision': false,
        actionHistory
      },
      { new: true }
    );

    if (!rejectedNews) {
      return res.status(409).json({
        error: 'News state changed. Refresh and try again.',
      });
    }

    const io = req.app.locals.io;
    if (io) {
      const { emitWorkflowPair } = require('../services/realtime/workflowEmit');
      emitWorkflowPair(
        io,
        rejectedNews.authorId,
        {
          id: rejectedNews._id,
          authorId: rejectedNews.authorId,
          status: 'rejected',
          rejectionStatus: rejectedNews.rejectionStatus,
        },
        {
          id: rejectedNews._id,
          authorId: rejectedNews.authorId,
          status: 'rejected',
          title: rejectedNews.title,
        }
      );
    }

    res.json({
      success: true,
      message: 'News rejected',
      reason: reason || 'No reason provided',
      news: rejectedNews
    });
  } catch (error) {
    console.error('Error rejecting news:', error);
    res.status(500).json({ error: 'Failed to reject news' });
  }
}

/**
 * Send pending news back for revision (Needs Revision).
 * Does NOT set rejectionStatus. Keeps isActive false.
 */
async function sendBackForEdit(req, res) {
  try {
    const { id } = req.params;
    const remarks = typeof req.body?.remarks === 'string' ? req.body.remarks.trim() : '';

    if (!remarks || remarks.length < 5) {
      return res.status(400).json({
        error: 'Revision remarks are required (minimum 5 characters).',
      });
    }
    if (remarks.length > 2000) {
      return res.status(400).json({
        error: 'Revision remarks cannot exceed 2000 characters.',
      });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid news ID' });
    }

    const adminId =
      req.adminId || req.userId || req.admin?.id || req.admin?._id?.toString();
    let adminName = 'Editor';
    let adminRole = 'Editor';
    let adminRoleRaw = req.admin?.role || '';

    if (adminId) {
      const admin = await Admin.findById(adminId)
        .select('username role permissions')
        .lean();
      if (!admin) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (
        admin.role === 'subeditor' &&
        (!admin.permissions || !admin.permissions.canApproveNews)
      ) {
        return res
          .status(403)
          .json({ error: 'You do not have permission to send news back for edit.' });
      }
      if (
        admin.role !== 'superadmin' &&
        admin.role !== 'admin' &&
        admin.role !== 'subeditor'
      ) {
        return res
          .status(403)
          .json({ error: 'Only admins and authorized subeditors can send news back.' });
      }
      adminName = admin.username;
      adminRoleRaw = admin.role;
      if (admin.role === 'superadmin' || admin.role === 'admin') {
        adminRole = 'Admin';
      } else if (admin.role === 'subeditor' || admin.role === 'sub_editor') {
        adminRole = 'Sub Editor';
      } else {
        adminRole = admin.role
          ? admin.role.charAt(0).toUpperCase() + admin.role.slice(1)
          : 'Editor';
      }
    } else {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const existingNews = await News.findById(id);
    if (!existingNews) {
      return res.status(404).json({ error: 'News not found' });
    }

    if (existingNews.isActive === true) {
      return res.status(400).json({
        error: 'Published news cannot be sent back for revision.',
      });
    }
    if (existingNews.rejectionStatus && existingNews.rejectionStatus.isRejected) {
      return res.status(400).json({
        error: 'Rejected news cannot be sent back for revision. Reject is final.',
      });
    }

    const {
      captureRevisionSnapshot,
    } = require('../services/newsRevision/revisionHelpers');

    const prev = existingNews.revisionStatus || {};
    const nextCount = (Number(prev.revisionCount) || 0) + 1;
    const snapshot = captureRevisionSnapshot(existingNews, nextCount);
    const sentAt = new Date();

    const actionHistory = Array.isArray(existingNews.actionHistory)
      ? [...existingNews.actionHistory]
      : [];
    actionHistory.push(
      buildAdminNewsHistory(
        'needs_revision',
        adminId,
        adminName,
        adminRole,
        `Sent back for revision (round ${nextCount})`,
        {
          round: nextCount,
          remarks,
          role: adminRoleRaw,
        }
      )
    );

    const revisionStatus = {
      needsRevision: true,
      remarks,
      sentBackBy: adminName,
      sentBackById: String(adminId),
      sentBackByRole: adminRole,
      sentAt,
      revisionCount: nextCount,
      lastRevisionRound: nextCount,
      lastResubmitRound: Number(prev.lastResubmitRound) || 0,
      resubmittedAt: prev.resubmittedAt || null,
      revisionSnapshot: snapshot,
      lastChangeSummary: prev.lastChangeSummary || null,
    };

    // Atomic send-back: exclusive with concurrent resubmit (fingerprint needsRevision + revisionCount)
    const prevNeedsRevision = prev.needsRevision === true;
    const prevCount = Number(prev.revisionCount) || 0;
    const sendBackFilter = {
      _id: id,
      isActive: { $ne: true },
      'rejectionStatus.isRejected': { $ne: true },
    };
    if (prevNeedsRevision) {
      sendBackFilter['revisionStatus.needsRevision'] = true;
      sendBackFilter['revisionStatus.revisionCount'] = prevCount;
    } else {
      sendBackFilter['revisionStatus.needsRevision'] = { $ne: true };
      // First-time / waiting: count 0 or field absent (legacy docs)
      sendBackFilter.$and = [
        {
          $or: [
            { 'revisionStatus.revisionCount': prevCount },
            { 'revisionStatus.revisionCount': { $exists: false } },
            { revisionStatus: { $exists: false } },
          ],
        },
      ];
    }

    const savedNews = await News.findOneAndUpdate(
      sendBackFilter,
      {
        $set: {
          isActive: false,
          revisionStatus,
          actionHistory,
        },
      },
      { new: true }
    );

    if (!savedNews) {
      return res.status(409).json({
        error: 'News state changed. Refresh and try again.',
      });
    }

    const io = req.app.locals.io;
    if (io) {
      const { emitWorkflowPair } = require('../services/realtime/workflowEmit');
      emitWorkflowPair(
        io,
        savedNews.authorId,
        {
          id: savedNews._id,
          authorId: savedNews.authorId,
          status: 'needs_revision',
          message: 'Your news requires revision.',
          revisionStatus: {
            needsRevision: true,
            remarks,
            revisionCount: nextCount,
            lastRevisionRound: nextCount,
            sentBackBy: adminName,
            sentBackByRole: adminRole,
            sentAt,
          },
        },
        {
          id: savedNews._id,
          authorId: savedNews.authorId,
          status: 'needs_revision',
          message: 'Article sent back for revision.',
          title: savedNews.title,
          remarks,
          revisionStatus: {
            needsRevision: true,
            remarks,
            revisionCount: nextCount,
            lastRevisionRound: nextCount,
            sentBackBy: adminName,
            sentBackByRole: adminRole,
            sentAt,
          },
        }
      );
    }

    return res.json({
      success: true,
      message: 'News sent back for revision.',
      news: savedNews,
    });
  } catch (error) {
    console.error('Error sending news back for edit:', error);
    return res.status(500).json({ error: 'Failed to send news back for edit' });
  }
}

/**
 * Compare Versions payload for admin pending review.
 * Returns frozen revisionSnapshot (Previous) + current fields + lastChangeSummary + revision history.
 */
async function getNewsRevisionDiff(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid news ID' });
    }

    const adminId =
      req.adminId || req.userId || req.admin?.id || req.admin?._id?.toString();
    if (!adminId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const admin = await Admin.findById(adminId).select('role permissions').lean();
    if (!admin) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (
      admin.role !== 'superadmin' &&
      admin.role !== 'admin' &&
      !(admin.role === 'subeditor' && admin.permissions?.canApproveNews)
    ) {
      return res.status(403).json({
        error: 'You do not have permission to view revision comparison.',
      });
    }

    const news = await News.findById(id)
      .select(
        'title content category location language scope mediaUrl mediaType thumbnailUrl imageUrl imageUrls videoUrl sourceLink readFullLink ePaperLink revisionStatus actionHistory isActive rejectionStatus author authorId'
      )
      .lean();

    if (!news) {
      return res.status(404).json({ error: 'News not found' });
    }

    const rs = news.revisionStatus || {};
    const snapshot = rs.revisionSnapshot || null;
    let lastChangeSummary = rs.lastChangeSummary || null;

    // If summary missing but snapshot exists, compute on the fly for admin UI
    if (!lastChangeSummary && snapshot) {
      const { buildChangeSummary } = require('../services/newsRevision/revisionHelpers');
      lastChangeSummary = buildChangeSummary(
        snapshot,
        news,
        Number(rs.lastResubmitRound) || Number(rs.lastRevisionRound) || 1
      );
    }

    const history = Array.isArray(news.actionHistory)
      ? news.actionHistory.filter((entry) =>
          ['needs_revision', 'resubmitted', 'approved', 'rejected', 'created'].includes(
            entry && entry.action
          )
        )
      : [];

    return res.json({
      success: true,
      newsId: news._id,
      revisionStatus: {
        needsRevision: rs.needsRevision === true,
        remarks: rs.remarks || null,
        sentBackBy: rs.sentBackBy || null,
        sentBackByRole: rs.sentBackByRole || null,
        sentAt: rs.sentAt || null,
        revisionCount: Number(rs.revisionCount) || 0,
        lastRevisionRound: Number(rs.lastRevisionRound) || 0,
        lastResubmitRound: Number(rs.lastResubmitRound) || 0,
        resubmittedAt: rs.resubmittedAt || null,
      },
      previous: snapshot,
      current: {
        title: news.title || '',
        content: news.content || '',
        category: news.category || '',
        location: news.location || '',
        language: news.language || '',
        scope: news.scope || '',
        mediaUrl: news.mediaUrl || '',
        mediaType: news.mediaType || '',
        thumbnailUrl: news.thumbnailUrl || '',
        imageUrl: news.imageUrl || '',
        imageUrls: Array.isArray(news.imageUrls) ? news.imageUrls : [],
        videoUrl: news.videoUrl || '',
        sourceLink: news.sourceLink || '',
      },
      lastChangeSummary,
      history,
    });
  } catch (error) {
    console.error('Error loading revision diff:', error);
    return res.status(500).json({ error: 'Failed to load revision comparison' });
  }
}

// Check for duplicate articles (dry-run — does not save/publish).
// Uses the same gateway as createNews so AI ON/OFF + Node fallback stay identical.
async function checkDuplicateArticles(req, res) {
  try {
    const {
      title,
      content,
      language,
      excludeId,
      mediaUrl,
      mediaType,
      imageUrls,
      thumbnailUrl,
      videoUrl
    } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content required' });
    }

    const { contentHash, duplicateCheck: rawCheck } = await runDuplicateCheckGateway(
      {
        title,
        content,
        language: language || 'te',
        mediaUrl: mediaUrl || '',
        mediaType: mediaType || '',
        imageUrls: Array.isArray(imageUrls) ? imageUrls : [],
        thumbnailUrl: thumbnailUrl || '',
        videoUrl: videoUrl || ''
      },
      {
        excludeId: excludeId || null,
        includePendingCorpus: true
      }
    );

    const duplicateCheck = normalizeDuplicateCheck(rawCheck);
    const similarArticles = Array.isArray(duplicateCheck.similarArticles)
      ? duplicateCheck.similarArticles.slice(0, 10)
      : [];

    res.json({
      success: true,
      // Legacy response fields (unchanged contract for existing callers)
      hasDuplicate: duplicateCheck.isDuplicate === true,
      isSuspicious: duplicateCheck.isSuspicious === true,
      similarArticles,
      totalMatches: duplicateCheck.matchCount || similarArticles.length,
      // Reuse fields — Sub Editor publish gate can pass these back to createNews
      contentHash,
      duplicateCheck: {
        ...duplicateCheck,
        similarArticles
      },
      score: duplicateCheck.score || 0,
      matchCount: duplicateCheck.matchCount || similarArticles.length
    });
  } catch (error) {
    console.error('Error checking duplicates:', error);
    res.status(500).json({ error: 'Failed to check for duplicates' });
  }
}

/**
 * Lazy-load a reference article for duplicate review comparison.
 * Does not run detection. Auth: admin / superadmin / subeditor / editor.
 */
async function getDuplicateReferenceArticle(req, res) {
  try {
    const role = req.admin && req.admin.role;
    const allowed = ['admin', 'superadmin', 'subeditor', 'editor'];
    if (!req.admin || !allowed.includes(role)) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid news ID' });
    }

    const doc = await News.findById(id)
      .select(
        'title content author authorId category location scope language publishedAt createdAt updatedAt isActive mediaUrl mediaType imageUrl imageUrls thumbnailUrl videoUrl rejectionStatus'
      )
      .lean();

    if (!doc) {
      return res.status(404).json({ success: false, error: 'Article not found' });
    }

    const isRejected = doc.rejectionStatus?.isRejected === true;
    const publishStatus =
      doc.isActive === true && !isRejected
        ? 'published'
        : isRejected
          ? 'rejected'
          : 'not_published';
    const mediaUrl =
      doc.mediaUrl ||
      doc.imageUrl ||
      (Array.isArray(doc.imageUrls) && doc.imageUrls[0]) ||
      doc.thumbnailUrl ||
      null;

    return res.json({
      success: true,
      article: {
        id: String(doc._id),
        title: doc.title || '',
        content: doc.content || '',
        author: doc.author || '—',
        category: doc.category || null,
        location: doc.location || null,
        scope: doc.scope || null,
        state: doc.scope === 'state' ? doc.location || null : null,
        district: doc.scope === 'district' ? doc.location || null : null,
        language: doc.language || null,
        publishedAt: doc.publishedAt || null,
        createdAt: doc.createdAt || null,
        updatedAt: doc.updatedAt || null,
        isActive: doc.isActive === true,
        isRejected,
        publishStatus,
        mediaUrl,
        mediaType: doc.mediaType || (doc.videoUrl ? 'video' : 'image'),
        thumbnailUrl: doc.thumbnailUrl || mediaUrl,
        imageUrls: Array.isArray(doc.imageUrls) ? doc.imageUrls.filter(Boolean) : [],
        videoUrl: doc.videoUrl || null,
      },
    });
  } catch (error) {
    console.error('Error loading duplicate reference article:', error);
    return res.status(500).json({ success: false, error: 'Failed to load reference article' });
  }
}

/**
 * UI-only translation for duplicate review compare modal.
 * Never mutates stored news. Auth: admin / superadmin / subeditor / editor.
 */
async function translateForDuplicateReview(req, res) {
  try {
    const role = req.admin && req.admin.role;
    const allowed = ['admin', 'superadmin', 'subeditor', 'editor'];
    if (!req.admin || !allowed.includes(role)) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const { texts, targetLang, sourceLang } = req.body || {};
    if (!Array.isArray(texts) || !targetLang) {
      return res.status(400).json({ success: false, error: 'texts and targetLang are required' });
    }
    if (texts.length > 20) {
      return res.status(400).json({ success: false, error: 'Too many texts' });
    }

    const { translateTexts, ALLOWED } = require('../services/aiInsights/translateService');
    if (!ALLOWED.has(String(targetLang).toLowerCase())) {
      return res.status(400).json({ success: false, error: 'Unsupported language' });
    }

    const translations = await translateTexts(texts, targetLang, sourceLang || 'auto');
    return res.json({ success: true, translations, targetLang });
  } catch (error) {
    console.error('Error translating for duplicate review:', error);
    return res.status(500).json({ success: false, error: 'Translation failed' });
  }
}

// Render plagiarism report page
async function renderPlagiarismReportPage(req, res) {
  try {
    // Get all articles with duplicate info
    const allArticles = await News.find({})
      .select('_id title author publishedAt category location isActive duplicateCheck')
      .sort({ publishedAt: -1 })
      .lean();

    // Identify duplicates
    const duplicateArticles = allArticles.filter(
      article => article.duplicateCheck && (article.duplicateCheck.isDuplicate || article.duplicateCheck.isSuspicious)
    );

    // Group by similarity
    const highDuplicates = duplicateArticles.filter(a => a.duplicateCheck.isDuplicate);
    const suspiciousArticles = duplicateArticles.filter(a => a.duplicateCheck.isSuspicious && !a.duplicateCheck.isDuplicate);

    res.render('plagiarism-report', {
      title: 'Plagiarism & Duplicate Report',
      totalArticles: allArticles.length,
      duplicateCount: highDuplicates.length,
      suspiciousCount: suspiciousArticles.length,
      highDuplicates,
      suspiciousArticles,
      allArticles
    });
  } catch (error) {
    console.error('Error rendering plagiarism report:', error);
    res.status(500).send('Error loading plagiarism report');
  }
}

// Get duplicate details for a specific article
async function getDuplicateDetails(req, res) {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid article ID' });
    }

    const article = await News.findById(id)
      .select('title content duplicateCheck')
      .lean();

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    res.json({
      success: true,
      article: {
        id: article._id,
        title: article.title,
        duplicateCheck: article.duplicateCheck
      }
    });
  } catch (error) {
    console.error('Error fetching duplicate details:', error);
    res.status(500).json({ error: 'Failed to fetch duplicate details' });
  }
}

// Render rejected news page

async function renderRejectedNewsPage(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(10, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const searchQuery = (req.query.search || '').trim();
    const reasonFilter = (req.query.reason || '').trim();
    const categoryFilter = (req.query.category || '').trim();

    const baseMatch = { 'rejectionStatus.isRejected': true };
    const filterConditions = [baseMatch];

    if (searchQuery) {
      filterConditions.push({
        $or: [
          { title: { $regex: searchQuery, $options: 'i' } },
          { author: { $regex: searchQuery, $options: 'i' } },
          { category: { $regex: searchQuery, $options: 'i' } },
          { location: { $regex: searchQuery, $options: 'i' } },
          { 'rejectionStatus.reason': { $regex: searchQuery, $options: 'i' } },
          { 'rejectionStatus.feedback': { $regex: searchQuery, $options: 'i' } },
          { 'rejectionStatus.rejectedBy': { $regex: searchQuery, $options: 'i' } }
        ]
      });
    }

    if (reasonFilter) {
      filterConditions.push({ 'rejectionStatus.reason': reasonFilter });
    }

    if (categoryFilter) {
      filterConditions.push({ category: categoryFilter });
    }

    const query = filterConditions.length === 1
      ? filterConditions[0]
      : { $and: filterConditions };

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);

    const [
      totalFiltered,
      rejectedNews,
      totalAll,
      statsAgg,
      rejectionReasons,
      categories
    ] = await Promise.all([
      News.countDocuments(query),
      News.find(query)
        .sort({ 'rejectionStatus.rejectedAt': -1 })
        .skip(skip)
        .limit(limit)
        .select('title author category location language publishedAt rejectionStatus isActive views authorId')
        .lean(),
      News.countDocuments(baseMatch),
      News.aggregate([
        { $match: baseMatch },
        {
          $group: {
            _id: null,
            thisWeek: {
              $sum: {
                $cond: [{ $gte: ['$rejectionStatus.rejectedAt', weekAgo] }, 1, 0]
              }
            },
            withFeedback: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $ne: ['$rejectionStatus.feedback', null] },
                      { $ne: ['$rejectionStatus.feedback', ''] }
                    ]
                  },
                  1,
                  0
                ]
              }
            }
          }
        }
      ]),
      News.distinct('rejectionStatus.reason', baseMatch),
      News.distinct('category', baseMatch)
    ]);

    const stats = statsAgg[0] || { thisWeek: 0, withFeedback: 0 };
    const totalPages = Math.max(1, Math.ceil(totalFiltered / limit));
    const safePage = Math.min(page, totalPages);
    
    const authorIds = [...new Set(rejectedNews.map(n => n.authorId).filter(Boolean))];
    const authors = await Admin.find({ _id: { $in: authorIds } }).select('name email mobileNumber constituency').lean();
    const authorMap = {};
    authors.forEach(a => authorMap[a._id.toString()] = a);

    const rejectedNewsWithAuthors = rejectedNews.map(article => ({
      ...article,
      authorDetails: article.authorId ? authorMap[article.authorId.toString()] : null
    }));

    res.render('rejected-news', {
      admin: req.admin,
      title: 'Rejected News',
      rejectedNews: rejectedNewsWithAuthors,
      searchQuery,
      reasonFilter,
      categoryFilter,
      rejectionReasons: rejectionReasons.filter(Boolean).sort(),
      categories: categories.filter(Boolean).sort(),
      summary: {
        total: totalAll,
        thisWeek: stats.thisWeek || 0,
        withFeedback: stats.withFeedback || 0,
        filtered: totalFiltered
      },
      pagination: {
        currentPage: safePage,
        limit,
        totalRows: totalFiltered,
        totalPages
      }
    });
  } catch (error) {
    console.error('Error rendering rejected news page:', error);
    res.status(500).send('Error loading rejected news');
  }
}

async function renderPollsPage(req, res) {
  try {
    const Poll = require('../models/Poll');
    const Language = require('../models/Language');
    const polls = await Poll.find().sort({ createdAt: -1 }).lean();
    const languages = await Language.getActiveLanguages();
    
    res.render('polls', {
      admin: req.admin,
      activePage: 'polls',
      polls,
      languages
    });
  } catch (error) {
    console.error('Error rendering polls page:', error);
    res.status(500).send('Internal Server Error');
  }
}

async function createPollRest(req, res) {
  try {
    const Poll = require('../models/Poll');
    const { question, language, options } = req.body;
    
    if (!question || !language || !options || options.length < 2) {
      return res.status(400).json({ success: false, message: 'Question, language and at least 2 options are required' });
    }

    const newPoll = new Poll({
      question,
      language,
      options: options.map(opt => ({ text: opt, votes: 0 })),
      totalVotes: 0,
      votedUsers: [],
      isActive: true
    });

    await newPoll.save();
    res.json({ success: true, poll: newPoll });
  } catch (error) {
    console.error('Error creating poll:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

async function deletePollRest(req, res) {
  try {
    const Poll = require('../models/Poll');
    const { id } = req.params;
    
    await Poll.findByIdAndDelete(id);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting poll:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

async function updatePollStatusRest(req, res) {
  try {
    const Poll = require('../models/Poll');
    const { id } = req.params;
    const { isActive } = req.body;
    
    await Poll.findByIdAndUpdate(id, { isActive });
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating poll status:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

async function updatePollRest(req, res) {
  try {
    const Poll = require('../models/Poll');
    const { id } = req.params;
    const { question, language, options } = req.body;
    
    if (!question || !language || !options || options.length < 2) {
      return res.status(400).json({ success: false, message: 'Question, language and at least 2 options are required' });
    }

    const poll = await Poll.findById(id);
    if (!poll) {
      return res.status(404).json({ success: false, message: 'Poll not found' });
    }

    poll.question = question;
    poll.language = language;
    
    // Update existing options or add new ones
    // We shouldn't lose existing votes for matched options by text, but for simplicity we will reset votes for now
    // Actually, preserving votes for matching text options is better
    const newOptions = options.map(opt => {
      const existing = poll.options.find(o => o.text === opt);
      return { text: opt, votes: existing ? existing.votes : 0 };
    });
    
    poll.options = newOptions;
    
    // Recalculate total votes
    poll.totalVotes = newOptions.reduce((sum, opt) => sum + (opt.votes || 0), 0);

    await poll.save();
    res.json({ success: true, poll });
  } catch (error) {
    console.error('Error updating poll:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

async function renderRegistrationFieldsPage(req, res) {
  try {
    const fields = await RegistrationField.find().sort({ order: 1 });
    res.render('registration-fields', {
      admin: req.admin,
      activePage: 'registration-fields',
      fields
    });
  } catch (error) {
    console.error('Error rendering registration fields page:', error);
    res.status(500).send('Internal Server Error');
  }
}

async function renderReporterApplicationsPage(req, res) {
  try {
    const applications = await ReporterApplication.find().sort({ createdAt: -1 }).lean();
    const registrationFields = await RegistrationField.find({ isActive: true }).sort({ order: 1 }).lean();
    res.render('reporter-applications', {
      admin: req.admin,
      activePage: 'reporter-applications',
      applications,
      registrationFields
    });
  } catch (error) {
    console.error('Error rendering reporter applications page:', error);
    res.status(500).send('Internal Server Error');
  }
}

// Delete all rejected news
async function deleteAllRejectedNews(req, res) {
  try {
    const { password } = req.body;
    
    // Check password from .env
    const envPassword = process.env.REJECTED_NEWS_DELETE_PASSWORD;
    if (!envPassword) {
      return res.status(500).json({ success: false, message: 'Delete password not configured in .env' });
    }
    
    if (password !== envPassword) {
      return res.status(401).json({ success: false, message: 'Invalid password' });
    }
    
    // Delete all news where rejectionStatus.isRejected is true
    const result = await News.deleteMany({ 'rejectionStatus.isRejected': true });
    
    if (result.deletedCount === 0) {
      return res.status(200).json({ success: true, message: 'No rejected news found to delete' });
    }
    
    res.status(200).json({ success: true, message: `Successfully deleted ${result.deletedCount} rejected news` });
  } catch (error) {
    console.error('Error in deleteAllRejectedNews:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

// Update Reporter Application
async function updateReporterApplication(req, res) {
  try {
    const { id } = req.params;
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ success: false, message: 'Missing data to update' });
    }

    const application = await ReporterApplication.findById(id);
    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }

    // Merge existing data with new data
    application.data = { ...application.data, ...data };
    
    await application.save();

    res.json({ success: true, message: 'Application updated successfully', data: application.data });
  } catch (error) {
    console.error('Error updating reporter application:', error);
    res.status(500).json({ success: false, message: 'Error updating application' });
  }
}

// Delete single rejected news by id
async function deleteRejectedNewsById(req, res) {
  try {
    const { id } = req.params;
    const { password } = req.body;
    
    // Check password from .env
    const envPassword = process.env.REJECTED_NEWS_DELETE_PASSWORD;
    if (!envPassword) {
      return res.status(500).json({ success: false, message: 'Delete password not configured in .env' });
    }
    
    if (password !== envPassword) {
      return res.status(401).json({ success: false, message: 'Invalid password' });
    }
    
    const result = await News.findOneAndDelete({ _id: id, 'rejectionStatus.isRejected': true });
    
    if (!result) {
       return res.status(404).json({ success: false, message: 'Rejected news article not found' });
    }
    
    res.json({ 
      success: true, 
      message: 'Successfully deleted the rejected news article.' 
    });
  } catch (error) {
    console.error('Error deleting rejected news by id:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
}

// ==========================================
// REFERRALS MANAGEMENT
// ==========================================

const renderReferralsPage = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id);
    if (!admin) return res.redirect('/login');

    const Referral = require('../models/Referral');
    
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const skip = (page - 1) * limit;
    const searchQuery = (req.query.search || '').trim();
    const statusFilter = req.query.status || '';

    const query = {};
    if (searchQuery) {
      query.$or = [
        { referrerEmail: new RegExp(searchQuery, 'i') },
        { referredEmail: new RegExp(searchQuery, 'i') },
        { referralCode: new RegExp(searchQuery, 'i') }
      ];
    }
    if (statusFilter) {
      query.status = statusFilter;
    }

    const [referrals, totalCount] = await Promise.all([
      Referral.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Referral.countDocuments(query)
    ]);

    res.render('referrals', {
      admin,
      referrals,
      currentPage: page,
      totalPages: Math.ceil(totalCount / limit),
      search: searchQuery,
      status: statusFilter,
      currentRoute: '/admin/referrals',
      activePage: 'referrals'
    });
  } catch (error) {
    console.error('Error in renderReferralsPage:', error);
    res.status(500).send('Server Error');
  }
};

const updateReferralStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!['verified', 'rejected', 'paid'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const Referral = require('../models/Referral');
    const User = require('../models/User');
    
    const referral = await Referral.findById(id);
    if (!referral) return res.status(404).json({ error: 'Referral not found' });
    
    if (status === 'verified' && referral.status !== 'verified') {
      // Credit wallet
      referral.verifiedAt = new Date();
      await User.findOneAndUpdate(
        { googleId: referral.referrerUserId },
        {
          $inc: {
            walletBalance: referral.commissionAmount,
            totalEarned: referral.commissionAmount,
            totalReferrals: 1
          }
        }
      );
    }

    referral.status = status;
    if (status === 'rejected') {
      referral.rejectionReason = 'manual_reject';
    }

    await referral.save();
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating referral status:', error);
    res.status(500).json({ error: 'Server Error' });
  }
};

// ==========================================
// User Deletion (Protected by .env password)
// ==========================================
const deleteUserById = async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;

    const envPassword = process.env.USER_DELETE_PASSWORD || process.env.REJECTED_NEWS_DELETE_PASSWORD;

    if (!envPassword) {
      return res.status(500).json({ success: false, message: 'Deletion password not configured on server (.env)' });
    }

    if (!password || password !== envPassword) {
      return res.status(401).json({ success: false, message: 'Invalid deletion password' });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await User.findByIdAndDelete(id);

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ success: false, message: 'Server error while deleting user' });
  }
};

/**
 * Reporter home — period news / reject counts.
 * Ranges: today | yesterday | 7d | custom (from/to YYYY-MM-DD, IST).
 * News model has no createdAt — filter by publishedAt (same as daily-stats).
 */
async function getReporterPeriodStats(req, res) {
  try {
    const reporterId = req.adminId || req.userId || req.admin?.id || req.admin?._id?.toString();
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const requested = String(req.query.range || 'today');
    const allowed = new Set(['today', 'yesterday', '7d', 'custom']);
    if (!allowed.has(requested)) {
      return res.status(400).json({ error: 'range must be today, yesterday, 7d, or custom' });
    }

    const rangeInfo = resolveAnalyticsDateRange({
      range: requested,
      from: req.query.from,
      to: req.query.to,
    });
    if (rangeInfo.error) return res.status(400).json({ error: rangeInfo.error });

    const { from, to, label } = rangeInfo;
    const [row] = await News.aggregate([
      {
        $match: {
          authorId: String(reporterId),
          publishedAt: { $gte: from, $lte: to },
        },
      },
      {
        $group: {
          _id: null,
          newsCount: { $sum: 1 },
          rejectedCount: {
            $sum: {
              $cond: [{ $eq: ['$rejectionStatus.isRejected', true] }, 1, 0],
            },
          },
        },
      },
    ]);

    return res.json({
      range: requested,
      label,
      from: from.toISOString(),
      to: to.toISOString(),
      newsCount: row?.newsCount || 0,
      rejectedCount: row?.rejectedCount || 0,
    });
  } catch (error) {
    console.error('Error fetching reporter period stats:', error);
    return res.status(500).json({ error: 'Failed to fetch period stats' });
  }
}

// Get reporter daily stats for UI dashboard
async function getReporterDailyStats(req, res) {
  try {
    const reporterId = req.adminId || req.userId || req.admin?.id || req.admin?._id?.toString();
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const admin = await Admin.findById(reporterId);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });

    const { AppSettings } = require('../models/AppSettings');
    const settings = await require('../models/AppSettings').findOne({ key: 'update_flags' });
    const { resolveWalletConfig } = require('../utils/walletHelpers');
    const walletCfg = resolveWalletConfig(admin, settings);

    // Wallet OFF: app lo wallet/earnings sections hide cheyadaniki flag matrame pampistham
    if (!walletCfg.enabled) {
      return res.json({ walletEnabled: false });
    }

    const maxReward = walletCfg.maxReward;
    const targetNews = walletCfg.targetNews;
    const amountPerNews = maxReward / targetNews;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const newsToday = await News.find({
      authorId: reporterId,
      publishedAt: { $gte: startOfDay, $lte: endOfDay }
    }).lean();

    const approvedToday = await News.countDocuments({
      authorId: reporterId,
      isActive: true,
      'approvalStatus.isApproved': true,
      'approvalStatus.approvedAt': { $gte: startOfDay, $lte: endOfDay }
    });

    let pendingCount = 0;
    let rejectedCount = 0;

    newsToday.forEach(n => {
      if (!n.isActive && !n.rejectionStatus?.isRejected) {
        pendingCount++;
      }
      if (n.rejectionStatus?.isRejected) {
        rejectedCount++;
      }
    });

    const isTargetReached = approvedToday >= targetNews;
    const remainingForReward = Math.max(0, targetNews - approvedToday);
    
    const dateString = startOfDay.toISOString().split('T')[0];
    const referenceId = `reward_${reporterId}_${dateString}`;
    const AdminWalletTransaction = require('../models/AdminWalletTransaction');
    const rewardGiven = await AdminWalletTransaction.exists({ referenceId });

    res.json({
      walletEnabled: true,
      approvedCount: approvedToday,
      rejectedCount,
      pendingCount,
      totalSubmittedToday: newsToday.length,
      targetNews,
      maxReward,
      amountPerNews,
      remainingForReward,
      isTargetReached,
      rewardGiven: !!rewardGiven,
      walletBalance: admin.walletBalance || 0,
      minWithdrawalAmount: settings?.minWithdrawalAmount || 500,
      maxWithdrawalAmount: settings?.maxWithdrawalAmount || 5000
    });
  } catch (error) {
    console.error('Error fetching daily stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
}

// Render Reporter Wallet Page
async function renderReporterWalletPage(req, res) {
  try {
    const admin = await Admin.findById(req.adminId || req.userId || req.admin?.id).lean();
    res.render('my-wallet', {
      title: 'My Wallet',
      admin,
      activePage: 'my-wallet'
    });
  } catch (err) {
    res.status(500).send('Error loading wallet page');
  }
}

// Render Wallet Settings Page
async function renderWalletSettingsPage(req, res) {
  try {
    const admin = await Admin.findById(req.adminId || req.userId || req.admin?.id).lean();
    res.render('wallet-settings', {
      title: 'Wallet Settings',
      admin,
      activePage: 'wallet-settings'
    });
  } catch (err) {
    res.status(500).send('Error loading wallet settings page');
  }
}

// Get wallet settings (JSON)
async function getWalletSettings(req, res) {
  try {
    const AppSettings = require('../models/AppSettings');
    let settings = await AppSettings.findOne({ key: 'update_flags' });
    if (!settings) {
      settings = await new AppSettings().save();
    }
    const fixed = settings.minWithdrawalAmount ?? 500;
    res.json({
      reporterTargetNews: settings.reporterTargetNews ?? 5,
      reporterMaxDailyReward: settings.reporterMaxDailyReward ?? 30,
      fixedWithdrawalAmount: fixed,
      // Kept for older clients — always same as fixed amount
      minWithdrawalAmount: fixed,
      maxWithdrawalAmount: fixed
    });
  } catch (error) {
    console.error('Error fetching wallet settings:', error);
    res.status(500).json({ error: 'Failed to fetch wallet settings' });
  }
}

// Update wallet settings
async function updateWalletSettings(req, res) {
  try {
    const {
      reporterTargetNews,
      reporterMaxDailyReward,
      fixedWithdrawalAmount,
      minWithdrawalAmount
    } = req.body;

    const target = Number(reporterTargetNews);
    const maxReward = Number(reporterMaxDailyReward);
    // Single fixed daily withdraw amount (prefer new field; fall back to min)
    const fixedWithdraw = Number(
      fixedWithdrawalAmount != null ? fixedWithdrawalAmount : minWithdrawalAmount
    );

    if (!Number.isFinite(target) || target < 1) {
      return res.status(400).json({ error: 'Target news count must be at least 1' });
    }
    if (!Number.isFinite(maxReward) || maxReward < 1) {
      return res.status(400).json({ error: 'Max daily reward must be at least ₹1' });
    }
    if (!Number.isFinite(fixedWithdraw) || fixedWithdraw < 1) {
      return res.status(400).json({ error: 'Fixed withdrawal amount must be at least ₹1' });
    }

    const AppSettings = require('../models/AppSettings');
    let settings = await AppSettings.findOne({ key: 'update_flags' });
    if (!settings) {
      settings = new AppSettings();
    }

    const beforeSettings = {
      reporterTargetNews: settings.reporterTargetNews,
      reporterMaxDailyReward: settings.reporterMaxDailyReward,
      fixedWithdrawalAmount: settings.minWithdrawalAmount
    };

    settings.reporterTargetNews = Math.floor(target);
    settings.reporterMaxDailyReward = maxReward;
    // Fixed daily withdraw: min = max = same amount
    settings.minWithdrawalAmount = fixedWithdraw;
    settings.maxWithdrawalAmount = fixedWithdraw;
    await settings.save();

    const { logAudit } = require('../utils/auditLogger');
    logAudit({
      req,
      action: 'wallet_settings_update',
      entityType: 'AppSettings',
      entityId: settings._id,
      description: `Wallet settings changed — target ${beforeSettings.reporterTargetNews}→${settings.reporterTargetNews}, reward ₹${beforeSettings.reporterMaxDailyReward}→₹${settings.reporterMaxDailyReward}, withdraw ₹${beforeSettings.fixedWithdrawalAmount}→₹${fixedWithdraw}`,
      before: beforeSettings,
      after: {
        reporterTargetNews: settings.reporterTargetNews,
        reporterMaxDailyReward: settings.reporterMaxDailyReward,
        fixedWithdrawalAmount: fixedWithdraw
      }
    });

    res.json({
      success: true,
      reporterTargetNews: settings.reporterTargetNews,
      reporterMaxDailyReward: settings.reporterMaxDailyReward,
      fixedWithdrawalAmount: settings.minWithdrawalAmount,
      minWithdrawalAmount: settings.minWithdrawalAmount,
      maxWithdrawalAmount: settings.maxWithdrawalAmount
    });
  } catch (error) {
    console.error('Error updating wallet settings:', error);
    res.status(500).json({ error: 'Failed to update wallet settings' });
  }
}

function resolveReporterId(req) {
  return req.adminId || req.userId || req.admin?.id || req.admin?._id?.toString() || null;
}

// List wallet transactions for the logged-in reporter
async function getReporterWalletTransactions(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const type = req.query.type; // credit | debit | undefined
    const from = req.query.from; // YYYY-MM-DD
    const to = req.query.to;

    const AdminWalletTransaction = require('../models/AdminWalletTransaction');
    const filter = { adminId: reporterId };
    if (type === 'credit' || type === 'debit') filter.type = type;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(`${from}T00:00:00.000+05:30`);
      if (to) filter.createdAt.$lte = new Date(`${to}T23:59:59.999+05:30`);
    }

    const [transactions, total] = await Promise.all([
      AdminWalletTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AdminWalletTransaction.countDocuments(filter)
    ]);

    res.json({
      transactions: transactions.map(tx => ({
        id: tx._id,
        amount: tx.amount,
        type: tx.type,
        description: tx.description,
        balanceBefore: tx.balanceBefore,
        balanceAfter: tx.balanceAfter,
        referenceId: tx.referenceId || null,
        createdAt: tx.createdAt,
        date: tx.createdAt
          ? new Date(tx.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
          : null
      })),
      page,
      limit,
      total,
      hasMore: skip + transactions.length < total
    });
  } catch (error) {
    console.error('Error fetching wallet transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
}

/** Full wallet overview: totals + day-wise earnings + withdrawal stats */
async function getReporterWalletSummary(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const admin = await Admin.findById(reporterId).lean();
    if (!admin) return res.status(404).json({ error: 'Account not found' });

    const AdminWalletTransaction = require('../models/AdminWalletTransaction');
    const WithdrawalRequest = require('../models/WithdrawalRequest');
    const AppSettings = require('../models/AppSettings');
    const mongoose = require('mongoose');
    const settings = await AppSettings.findOne({ key: 'update_flags' });

    const { resolveWalletConfig } = require('../utils/walletHelpers');
    const walletCfg = resolveWalletConfig(admin, settings);
    if (!walletCfg.enabled) {
      return res.json({ walletEnabled: false });
    }

    const adminOid = new mongoose.Types.ObjectId(reporterId);
    const now = new Date();

    // Week start (Mon) IST-ish using local; for consistency use rolling 7 days
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - 6);
    weekStart.setHours(0, 0, 0, 0);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      creditAgg,
      debitAgg,
      weekCreditAgg,
      monthCreditAgg,
      earningsByDate,
      withdrawals,
      lastCredit
    ] = await Promise.all([
      AdminWalletTransaction.aggregate([
        { $match: { adminId: adminOid, type: 'credit' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      AdminWalletTransaction.aggregate([
        { $match: { adminId: adminOid, type: 'debit' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      AdminWalletTransaction.aggregate([
        { $match: { adminId: adminOid, type: 'credit', createdAt: { $gte: weekStart } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      AdminWalletTransaction.aggregate([
        { $match: { adminId: adminOid, type: 'credit', createdAt: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      AdminWalletTransaction.aggregate([
        { $match: { adminId: adminOid, type: 'credit' } },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$createdAt',
                timezone: 'Asia/Kolkata'
              }
            },
            amount: { $sum: '$amount' },
            count: { $sum: 1 },
            lastAt: { $max: '$createdAt' }
          }
        },
        { $sort: { _id: -1 } },
        { $limit: 90 }
      ]),
      WithdrawalRequest.find({ adminId: reporterId }).sort({ createdAt: -1 }).limit(100).lean(),
      AdminWalletTransaction.findOne({ adminId: reporterId, type: 'credit' })
        .sort({ createdAt: -1 })
        .lean()
    ]);

    const totalEarned = creditAgg[0]?.total || 0;
    const totalDebited = debitAgg[0]?.total || 0;
    const creditCount = creditAgg[0]?.count || 0;
    const thisWeekEarned = weekCreditAgg[0]?.total || 0;
    const thisMonthEarned = monthCreditAgg[0]?.total || 0;

    const wdStats = { pending: 0, approved: 0, rejected: 0, pendingAmount: 0, approvedAmount: 0 };
    withdrawals.forEach(w => {
      if (w.status === 'pending') {
        wdStats.pending += 1;
        wdStats.pendingAmount += w.amount;
      } else if (w.status === 'approved') {
        wdStats.approved += 1;
        wdStats.approvedAmount += w.amount;
      } else if (w.status === 'rejected') {
        wdStats.rejected += 1;
      }
    });

    const walletBalance = admin.walletBalance || 0;
    const minWithdrawalAmount = settings?.minWithdrawalAmount || 500;
    const maxWithdrawalAmount = settings?.maxWithdrawalAmount || 5000;

    let withdrawBlockedReason = null;
    if (wdStats.pending > 0) {
      withdrawBlockedReason = 'You already have a pending withdrawal';
    } else if (walletBalance < minWithdrawalAmount) {
      withdrawBlockedReason = `Minimum ₹${minWithdrawalAmount} withdrawal`;
    }

    const daysEarnedThisMonth = earningsByDate.filter(d => {
      const [y, m] = d._id.split('-').map(Number);
      return y === now.getFullYear() && m === now.getMonth() + 1;
    }).length;

    res.json({
      walletEnabled: true,
      walletBalance,
      totalEarned,
      totalWithdrawn: wdStats.approvedAmount || totalDebited,
      totalDebited,
      creditCount,
      thisWeekEarned,
      thisMonthEarned,
      daysEarnedThisMonth,
      lastEarnedAt: lastCredit?.createdAt || null,
      lastEarnedAmount: lastCredit?.amount || 0,
      minWithdrawalAmount,
      maxWithdrawalAmount,
      canWithdraw: !withdrawBlockedReason,
      withdrawBlockedReason,
      withdrawalStats: wdStats,
      earningsByDate: earningsByDate.map(d => ({
        date: d._id,
        amount: d.amount,
        count: d.count,
        lastAt: d.lastAt
      })),
      targetNews: walletCfg.targetNews,
      maxReward: walletCfg.maxReward
    });
  } catch (error) {
    console.error('Error fetching wallet summary:', error);
    res.status(500).json({ error: 'Failed to fetch wallet summary' });
  }
}

// Cancel a pending withdrawal (reporter)
async function cancelReporterWithdrawal(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    const WithdrawalRequest = require('../models/WithdrawalRequest');
    const withdrawal = await WithdrawalRequest.findOne({ _id: id, adminId: reporterId });
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: `Cannot cancel a ${withdrawal.status} request` });
    }

    withdrawal.status = 'rejected';
    withdrawal.remarks = 'Cancelled by reporter';
    withdrawal.processedAt = new Date();
    withdrawal.processedBy = reporterId;
    await withdrawal.save();

    res.json({ success: true, message: 'Withdrawal cancelled' });
  } catch (error) {
    console.error('Error cancelling withdrawal:', error);
    res.status(500).json({ error: 'Failed to cancel withdrawal' });
  }
}

// List withdrawal requests for the logged-in reporter
async function getReporterWithdrawals(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const WithdrawalRequest = require('../models/WithdrawalRequest');
    const withdrawals = await WithdrawalRequest.find({ adminId: reporterId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({
      withdrawals: withdrawals.map(w => ({
        id: w._id,
        amount: w.amount,
        status: w.status,
        paymentDetails: w.paymentDetails,
        payoutType: w.payoutType || null,
        remarks: w.remarks || '',
        createdAt: w.createdAt,
        processedAt: w.processedAt
      }))
    });
  } catch (error) {
    console.error('Error fetching withdrawals:', error);
    res.status(500).json({ error: 'Failed to fetch withdrawals' });
  }
}

// Create a withdrawal request — asks UPI/Bank details every time (no saved account required)
async function createReporterWithdrawal(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Enter a valid withdrawal amount' });
    }

    const admin = await Admin.findById(reporterId);
    if (!admin) return res.status(404).json({ error: 'Account not found' });
    if (!admin.walletConfig?.enabled) {
      return res.status(403).json({ error: 'Wallet is not enabled for your account. Please contact admin.' });
    }
    if (admin.walletFrozen) {
      return res.status(403).json({
        error: 'Withdrawals are temporarily on hold for your account. Please contact admin.'
      });
    }

    const {
      validatePayoutPayload,
      formatPayoutMethodText
    } = require('../utils/payoutHelpers');

    const validated = validatePayoutPayload(req.body || {});
    if (validated.error) {
      return res.status(400).json({ error: validated.error });
    }

    const paymentDetails = formatPayoutMethodText(validated.data);
    const payoutType = validated.data.type;

    const AppSettings = require('../models/AppSettings');
    const settings = await AppSettings.findOne({ key: 'update_flags' });
    // Fixed daily redeem amount (admin sets min = max, e.g. ₹200 / ₹500 / ₹1000)
    const fixedWithdraw = settings?.minWithdrawalAmount || 500;
    const balance = admin.walletBalance || 0;

    if (Number(amount) !== Number(fixedWithdraw)) {
      return res.status(400).json({
        error: `Withdrawal amount must be exactly ₹${fixedWithdraw}`
      });
    }
    if (amount > balance) {
      return res.status(400).json({ error: 'Insufficient wallet balance' });
    }

    const WithdrawalRequest = require('../models/WithdrawalRequest');
    const pending = await WithdrawalRequest.findOne({ adminId: reporterId, status: 'pending' });
    if (pending) {
      return res.status(400).json({ error: 'You already have a pending withdrawal request' });
    }

    const withdrawal = await WithdrawalRequest.create({
      adminId: reporterId,
      amount,
      paymentDetails,
      payoutType,
      status: 'pending'
    });

    res.json({
      success: true,
      message: 'Withdrawal request submitted',
      withdrawal: {
        id: withdrawal._id,
        amount: withdrawal.amount,
        status: withdrawal.status,
        paymentDetails: withdrawal.paymentDetails,
        payoutType: withdrawal.payoutType,
        createdAt: withdrawal.createdAt
      }
    });
  } catch (error) {
    console.error('Error creating withdrawal:', error);
    res.status(500).json({ error: 'Failed to submit withdrawal request' });
  }
}

// List saved payout methods
async function getReporterPayoutMethods(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const admin = await Admin.findById(reporterId).select('payoutMethods');
    if (!admin) return res.status(404).json({ error: 'Account not found' });

    const { serializePayoutMethod, MAX_PAYOUT_METHODS } = require('../utils/payoutHelpers');
    const methods = (admin.payoutMethods || []).map(serializePayoutMethod);

    res.json({
      payoutMethods: methods,
      maxMethods: MAX_PAYOUT_METHODS,
      hasPayoutMethod: methods.length > 0
    });
  } catch (error) {
    console.error('Error listing payout methods:', error);
    res.status(500).json({ error: 'Failed to load payment accounts' });
  }
}

// Add payout method
async function addReporterPayoutMethod(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const {
      validatePayoutPayload,
      ensureSingleDefault,
      serializePayoutMethod,
      MAX_PAYOUT_METHODS
    } = require('../utils/payoutHelpers');

    const validated = validatePayoutPayload(req.body || {});
    if (validated.error) return res.status(400).json({ error: validated.error });

    const admin = await Admin.findById(reporterId);
    if (!admin) return res.status(404).json({ error: 'Account not found' });

    if (!admin.payoutMethods) admin.payoutMethods = [];
    if (admin.payoutMethods.length >= MAX_PAYOUT_METHODS) {
      return res.status(400).json({
        error: `You can save maximum ${MAX_PAYOUT_METHODS} accounts. Delete one to add another.`
      });
    }

    // Prevent duplicate UPI / account number
    if (validated.data.type === 'upi') {
      const exists = admin.payoutMethods.some(
        m => m.type === 'upi' && m.upiId === validated.data.upiId
      );
      if (exists) return res.status(400).json({ error: 'This UPI ID is already saved' });
    } else {
      const exists = admin.payoutMethods.some(
        m => m.type === 'bank' && m.accountNumber === validated.data.accountNumber
      );
      if (exists) return res.status(400).json({ error: 'This bank account is already saved' });
    }

    const makeDefault = !!req.body.isDefault || admin.payoutMethods.length === 0;
    admin.payoutMethods.push({
      ...validated.data,
      isDefault: makeDefault,
      createdAt: new Date()
    });

    if (makeDefault) {
      const added = admin.payoutMethods[admin.payoutMethods.length - 1];
      ensureSingleDefault(admin.payoutMethods, added._id);
    } else {
      ensureSingleDefault(admin.payoutMethods);
    }

    await admin.save();

    res.json({
      success: true,
      message: 'Payment account saved',
      payoutMethods: admin.payoutMethods.map(serializePayoutMethod)
    });
  } catch (error) {
    console.error('Error adding payout method:', error);
    res.status(500).json({ error: 'Failed to save payment account' });
  }
}

// Set default payout method
async function setDefaultReporterPayoutMethod(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });
    const { id } = req.params;

    const { ensureSingleDefault, serializePayoutMethod } = require('../utils/payoutHelpers');
    const admin = await Admin.findById(reporterId);
    if (!admin) return res.status(404).json({ error: 'Account not found' });

    const method = admin.payoutMethods.id(id);
    if (!method) return res.status(404).json({ error: 'Payment account not found' });

    ensureSingleDefault(admin.payoutMethods, id);
    await admin.save();

    res.json({
      success: true,
      payoutMethods: admin.payoutMethods.map(serializePayoutMethod)
    });
  } catch (error) {
    console.error('Error setting default payout method:', error);
    res.status(500).json({ error: 'Failed to update default account' });
  }
}

// Delete payout method
async function deleteReporterPayoutMethod(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });
    const { id } = req.params;

    const WithdrawalRequest = require('../models/WithdrawalRequest');
    const pending = await WithdrawalRequest.findOne({
      adminId: reporterId,
      status: 'pending',
      payoutMethodId: id
    });
    if (pending) {
      return res.status(400).json({
        error: 'Cannot delete this account while a withdrawal is waiting. Cancel the request first.'
      });
    }

    const { ensureSingleDefault, serializePayoutMethod } = require('../utils/payoutHelpers');
    const admin = await Admin.findById(reporterId);
    if (!admin) return res.status(404).json({ error: 'Account not found' });

    const method = admin.payoutMethods.id(id);
    if (!method) return res.status(404).json({ error: 'Payment account not found' });

    method.deleteOne();
    if (admin.payoutMethods.length) {
      ensureSingleDefault(admin.payoutMethods);
    }
    await admin.save();

    res.json({
      success: true,
      message: 'Payment account removed',
      payoutMethods: admin.payoutMethods.map(serializePayoutMethod),
      hasPayoutMethod: admin.payoutMethods.length > 0
    });
  } catch (error) {
    console.error('Error deleting payout method:', error);
    res.status(500).json({ error: 'Failed to delete payment account' });
  }
}

// Admin: list withdrawal requests
async function listWalletWithdrawals(req, res) {
  try {
    const status = req.query.status || 'pending';
    const WithdrawalRequest = require('../models/WithdrawalRequest');
    const filter = status === 'all' ? {} : { status };

    const [withdrawals, counts] = await Promise.all([
      WithdrawalRequest.find(filter)
        .populate('adminId', 'username name displayRole mobileNumber email walletBalance')
        .populate('processedBy', 'username name')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
      WithdrawalRequest.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$amount' } } }
      ])
    ]);

    const statusCounts = { pending: 0, approved: 0, rejected: 0 };
    const statusAmounts = { pending: 0, approved: 0, rejected: 0 };
    counts.forEach((c) => {
      statusCounts[c._id] = c.count;
      statusAmounts[c._id] = c.amount;
    });

    res.json({
      counts: statusCounts,
      amounts: statusAmounts,
      withdrawals: withdrawals.map(w => ({
        id: w._id,
        amount: w.amount,
        status: w.status,
        paymentDetails: w.paymentDetails,
        remarks: w.remarks || '',
        utr: w.utr || '',
        createdAt: w.createdAt,
        processedAt: w.processedAt,
        processedBy: w.processedBy
          ? (w.processedBy.name || w.processedBy.username)
          : null,
        reporter: w.adminId ? {
          id: w.adminId._id,
          name: w.adminId.name || w.adminId.username,
          username: w.adminId.username,
          mobileNumber: w.adminId.mobileNumber || '',
          email: w.adminId.email || '',
          walletBalance: w.adminId.walletBalance ?? 0
        } : null
      }))
    });
  } catch (error) {
    console.error('Error listing withdrawals:', error);
    res.status(500).json({ error: 'Failed to list withdrawals' });
  }
}

// Admin: approve or reject withdrawal
async function processWalletWithdrawal(req, res) {
  try {
    const { id } = req.params;
    const action = String(req.body.action || '').toLowerCase();
    const remarks = String(req.body.remarks || '').trim();
    const utr = String(req.body.utr || '').trim();

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve or reject' });
    }
    if (action === 'reject' && !remarks) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    const WithdrawalRequest = require('../models/WithdrawalRequest');
    const withdrawal = await WithdrawalRequest.findById(id).populate('adminId', 'username name');
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: `Request already ${withdrawal.status}` });
    }

    const processorId = resolveReporterId(req);
    const { logAudit } = require('../utils/auditLogger');
    const reporterName = withdrawal.adminId?.name || withdrawal.adminId?.username || '';
    const reporterId = withdrawal.adminId?._id || withdrawal.adminId;

    if (action === 'reject') {
      withdrawal.status = 'rejected';
      withdrawal.remarks = remarks;
      withdrawal.processedBy = processorId;
      withdrawal.processedAt = new Date();
      await withdrawal.save();

      logAudit({
        req,
        action: 'withdrawal_reject',
        entityType: 'WithdrawalRequest',
        entityId: withdrawal._id,
        targetId: reporterId,
        targetName: reporterName,
        description: `Rejected withdrawal of ₹${withdrawal.amount} — ${remarks}`,
        before: { status: 'pending' },
        after: { status: 'rejected', remarks }
      });

      return res.json({ success: true, message: 'Withdrawal rejected', withdrawal });
    }

    // Approve → debit wallet then mark approved
    const { processWalletTransaction } = require('../utils/walletHelpers');
    const referenceId = `withdraw_${withdrawal._id}`;

    try {
      await processWalletTransaction({
        adminId: reporterId,
        amount: withdrawal.amount,
        type: 'debit',
        description: `Withdrawal approved — ${withdrawal.paymentDetails}`.slice(0, 200),
        referenceId
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Failed to debit wallet' });
    }

    withdrawal.status = 'approved';
    withdrawal.remarks = remarks || 'Paid';
    withdrawal.utr = utr;
    withdrawal.processedBy = processorId;
    withdrawal.processedAt = new Date();
    await withdrawal.save();

    logAudit({
      req,
      action: 'withdrawal_approve',
      entityType: 'WithdrawalRequest',
      entityId: withdrawal._id,
      targetId: reporterId,
      targetName: reporterName,
      description: `Approved withdrawal of ₹${withdrawal.amount}${utr ? ` (UTR: ${utr})` : ''}`,
      before: { status: 'pending' },
      after: { status: 'approved', remarks: withdrawal.remarks, utr }
    });

    res.json({ success: true, message: 'Withdrawal approved and wallet debited', withdrawal });
  } catch (error) {
    console.error('Error processing withdrawal:', error);
    res.status(500).json({ error: 'Failed to process withdrawal' });
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — Admin: transactions ledger, manual adjustment, audit logs
// ---------------------------------------------------------------------------

async function renderWithdrawalsQueuePage(req, res) {
  try {
    res.render('withdrawals-queue', {
      title: 'Withdrawals Queue',
      admin: req.admin,
      activePage: 'withdrawals-queue'
    });
  } catch (error) {
    console.error('Error rendering withdrawals queue:', error);
    res.status(500).send('Error loading page');
  }
}

async function renderWalletTransactionsPage(req, res) {
  try {
    res.render('wallet-transactions', {
      title: 'Wallet Transactions',
      admin: req.admin,
      activePage: 'wallet-transactions'
    });
  } catch (error) {
    console.error('Error rendering wallet transactions page:', error);
    res.status(500).send('Error loading page');
  }
}

async function buildWalletTxFilter(query) {
  const filter = {};
  const type = String(query.type || '').toLowerCase();
  if (type === 'credit' || type === 'debit') filter.type = type;

  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(`${query.from}T00:00:00.000+05:30`);
    if (query.to) filter.createdAt.$lte = new Date(`${query.to}T23:59:59.999+05:30`);
  }

  const q = String(query.q || '').trim();
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const admins = await Admin.find({ $or: [{ username: rx }, { name: rx }, { mobileNumber: rx }] })
      .select('_id')
      .limit(500)
      .lean();
    filter.adminId = { $in: admins.map((a) => a._id) };
  }
  if (query.reporterId) filter.adminId = query.reporterId;

  return filter;
}

// Admin: all reporters transactions ledger with filters + totals
async function listWalletTransactionsAdmin(req, res) {
  try {
    const AdminWalletTransaction = require('../models/AdminWalletTransaction');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;

    const filter = await buildWalletTxFilter(req.query);

    const [transactions, total, sums] = await Promise.all([
      AdminWalletTransaction.find(filter)
        .populate('adminId', 'username name mobileNumber walletBalance')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AdminWalletTransaction.countDocuments(filter),
      AdminWalletTransaction.aggregate([
        { $match: filter },
        { $group: { _id: '$type', amount: { $sum: '$amount' }, count: { $sum: 1 } } }
      ])
    ]);

    const totals = { creditAmount: 0, creditCount: 0, debitAmount: 0, debitCount: 0 };
    sums.forEach((s) => {
      if (s._id === 'credit') {
        totals.creditAmount = s.amount;
        totals.creditCount = s.count;
      } else if (s._id === 'debit') {
        totals.debitAmount = s.amount;
        totals.debitCount = s.count;
      }
    });

    res.json({
      page,
      limit,
      total,
      totals,
      transactions: transactions.map((t) => ({
        id: t._id,
        amount: t.amount,
        type: t.type,
        description: t.description,
        balanceBefore: t.balanceBefore,
        balanceAfter: t.balanceAfter,
        referenceId: t.referenceId || '',
        createdAt: t.createdAt,
        reporter: t.adminId
          ? {
              id: t.adminId._id,
              name: t.adminId.name || t.adminId.username,
              username: t.adminId.username,
              mobileNumber: t.adminId.mobileNumber || '',
              walletBalance: t.adminId.walletBalance ?? 0
            }
          : null
      }))
    });
  } catch (error) {
    console.error('Error listing wallet transactions:', error);
    res.status(500).json({ error: 'Failed to list transactions' });
  }
}

// Admin: export filtered transactions as CSV
async function exportWalletTransactionsCsv(req, res) {
  try {
    const AdminWalletTransaction = require('../models/AdminWalletTransaction');
    const filter = await buildWalletTxFilter(req.query);

    const transactions = await AdminWalletTransaction.find(filter)
      .populate('adminId', 'username name mobileNumber')
      .sort({ createdAt: -1 })
      .limit(10000)
      .lean();

    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const rows = [
      ['Date', 'Reporter', 'Mobile', 'Type', 'Amount', 'Balance Before', 'Balance After', 'Description', 'Reference'].join(',')
    ];
    transactions.forEach((t) => {
      rows.push(
        [
          new Date(t.createdAt).toLocaleString('en-IN'),
          t.adminId ? t.adminId.name || t.adminId.username : 'Unknown',
          t.adminId?.mobileNumber || '',
          t.type,
          t.amount,
          t.balanceBefore,
          t.balanceAfter,
          t.description,
          t.referenceId || ''
        ].map(esc).join(',')
      );
    });

    const { logAudit } = require('../utils/auditLogger');
    logAudit({
      req,
      action: 'transactions_export',
      entityType: 'AdminWalletTransaction',
      description: `Exported ${transactions.length} transactions to CSV`
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="wallet-transactions-${new Date().toISOString().split('T')[0]}.csv"`
    );
    res.send('\uFEFF' + rows.join('\n'));
  } catch (error) {
    console.error('Error exporting transactions:', error);
    res.status(500).json({ error: 'Failed to export transactions' });
  }
}

// Admin: export filtered transactions as PDF (same filters/data as CSV)
async function exportWalletTransactionsPdf(req, res) {
  try {
    const AdminWalletTransaction = require('../models/AdminWalletTransaction');
    const { streamPdfReport, pdfFilename, formatINR } = require('../utils/pdfReportExport');
    const filter = await buildWalletTxFilter(req.query);

    const transactions = await AdminWalletTransaction.find(filter)
      .populate('adminId', 'username name mobileNumber')
      .sort({ createdAt: -1 })
      .limit(10000)
      .lean();

    const columns = [
      'Date',
      'Reporter',
      'Mobile',
      'Type',
      'Amount',
      'Balance Before',
      'Balance After',
      'Description',
      'Reference'
    ];
    const tableRows = transactions.map((t) => [
      new Date(t.createdAt).toLocaleString('en-IN'),
      t.adminId ? t.adminId.name || t.adminId.username : 'Unknown',
      t.adminId?.mobileNumber || '',
      t.type,
      formatINR(t.amount),
      formatINR(t.balanceBefore),
      formatINR(t.balanceAfter),
      t.description,
      t.referenceId || ''
    ]);

    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    let dateRange = 'All dates';
    if (from && to) dateRange = `${from} to ${to}`;
    else if (from) dateRange = `From ${from}`;
    else if (to) dateRange = `Until ${to}`;

    // Summary from the exact same exported collection (no extra DB query)
    let totalCredit = 0;
    let totalDebit = 0;
    const reporterIds = new Set();
    transactions.forEach((t) => {
      const amt = Number(t.amount) || 0;
      if (t.type === 'credit') totalCredit += amt;
      else if (t.type === 'debit') totalDebit += amt;
      if (t.adminId?._id) reporterIds.add(String(t.adminId._id));
      else if (t.adminId) reporterIds.add(String(t.adminId));
    });
    const netAmount = totalCredit - totalDebit;
    const singleReporter =
      Boolean(req.query.reporterId) || reporterIds.size === 1;

    const summary = {
      dateRange,
      totalTransactions: transactions.length,
      totalCredit,
      totalDebit,
      netAmount,
      totalCreditFormatted: formatINR(totalCredit),
      totalDebitFormatted: formatINR(totalDebit),
      netAmountFormatted: formatINR(netAmount),
      showOpeningClosing: false
    };

    if (singleReporter && transactions.length > 0) {
      // Chronological extremes for one wallet only
      let earliest = transactions[0];
      let latest = transactions[0];
      transactions.forEach((t) => {
        const ts = new Date(t.createdAt).getTime();
        if (ts < new Date(earliest.createdAt).getTime()) earliest = t;
        if (ts > new Date(latest.createdAt).getTime()) latest = t;
      });
      summary.showOpeningClosing = true;
      summary.openingBalance = earliest.balanceBefore;
      summary.closingBalance = latest.balanceAfter;
      summary.openingBalanceFormatted = formatINR(earliest.balanceBefore);
      summary.closingBalanceFormatted = formatINR(latest.balanceAfter);
    }

    const { logAudit } = require('../utils/auditLogger');
    logAudit({
      req,
      action: 'transactions_export',
      entityType: 'AdminWalletTransaction',
      description: `Exported ${transactions.length} transactions to PDF`
    });

    const adminName = req.admin?.name || req.admin?.username || 'Admin';
    streamPdfReport({
      res,
      filename: pdfFilename('wallet-transactions'),
      title: 'Wallet Transactions Report',
      adminName,
      dateRange,
      columns,
      rows: tableRows,
      rightAlignColumns: [4, 5, 6],
      summary
    });
  } catch (error) {
    console.error('Error exporting transactions PDF:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to export transactions PDF' });
    }
  }
}

// Admin: manual wallet adjustment (credit/debit) with mandatory reason
async function createWalletAdjustment(req, res) {
  try {
    const { reporterId } = req.body;
    const type = String(req.body.type || '').toLowerCase();
    const amount = Number(req.body.amount);
    const reason = String(req.body.reason || '').trim();

    if (!reporterId) return res.status(400).json({ error: 'reporterId is required' });
    if (!['credit', 'debit'].includes(type)) {
      return res.status(400).json({ error: 'type must be credit or debit' });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than 0' });
    }
    if (reason.length < 5) {
      return res.status(400).json({ error: 'Reason is mandatory (min 5 characters)' });
    }

    const reporter = await Admin.findById(reporterId).select('username name walletBalance');
    if (!reporter) return res.status(404).json({ error: 'Reporter not found' });

    const { processWalletTransaction } = require('../utils/walletHelpers');
    const actor = req.admin?.username || 'admin';
    const balanceBefore = reporter.walletBalance || 0;

    let tx;
    try {
      tx = await processWalletTransaction({
        adminId: reporterId,
        amount,
        type,
        description: `Manual ${type} by ${actor} — ${reason}`.slice(0, 200),
        referenceId: `manual_${type}_${reporterId}_${Date.now()}`
      });
    } catch (err) {
      return res.status(400).json({ error: err.message || 'Adjustment failed' });
    }

    const { logAudit } = require('../utils/auditLogger');
    logAudit({
      req,
      action: type === 'credit' ? 'wallet_manual_credit' : 'wallet_manual_debit',
      entityType: 'AdminWalletTransaction',
      entityId: tx._id,
      targetId: reporter._id,
      targetName: reporter.name || reporter.username,
      description: `Manual ${type} ₹${amount} — ${reason}`,
      before: { walletBalance: balanceBefore },
      after: { walletBalance: tx.balanceAfter }
    });

    res.json({
      success: true,
      message: `₹${amount} ${type === 'credit' ? 'credited to' : 'debited from'} ${reporter.name || reporter.username}`,
      balanceAfter: tx.balanceAfter
    });
  } catch (error) {
    console.error('Error creating wallet adjustment:', error);
    res.status(500).json({ error: 'Failed to create adjustment' });
  }
}

// Admin: search reporters (for adjustment / filters autocomplete)
async function searchWalletReporters(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ reporters: [] });

    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const reporters = await Admin.find({
      role: { $in: ['editor', 'subeditor'] },
      $or: [{ username: rx }, { name: rx }, { mobileNumber: rx }]
    })
      .select('username name mobileNumber walletBalance')
      .limit(10)
      .lean();

    res.json({
      reporters: reporters.map((r) => ({
        id: r._id,
        name: r.name || r.username,
        username: r.username,
        mobileNumber: r.mobileNumber || '',
        walletBalance: r.walletBalance ?? 0
      }))
    });
  } catch (error) {
    console.error('Error searching reporters:', error);
    res.status(500).json({ error: 'Failed to search reporters' });
  }
}

async function renderAuditLogsPage(req, res) {
  try {
    res.render('audit-logs', {
      title: 'Audit Logs',
      admin: req.admin,
      activePage: 'audit-logs'
    });
  } catch (error) {
    console.error('Error rendering audit logs page:', error);
    res.status(500).send('Error loading page');
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — Reporter earnings analytics (overview, leaderboard, locations)
// ---------------------------------------------------------------------------

function analyticsDateRange(query) {
  const range = {};
  if (query.from) range.$gte = new Date(`${query.from}T00:00:00.000+05:30`);
  if (query.to) range.$lte = new Date(`${query.to}T23:59:59.999+05:30`);
  return Object.keys(range).length ? range : null;
}

async function renderReporterAnalyticsPage(req, res) {
  try {
    res.render('reporter-analytics', {
      title: 'Reporter Analytics',
      admin: req.admin,
      activePage: 'reporter-analytics'
    });
  } catch (error) {
    console.error('Error rendering reporter analytics page:', error);
    res.status(500).send('Error loading page');
  }
}

// Overview cards: earnings paid, withdrawals, active reporters, news funnel
async function getReporterAnalyticsOverview(req, res) {
  try {
    const AdminWalletTransaction = require('../models/AdminWalletTransaction');
    const WithdrawalRequest = require('../models/WithdrawalRequest');
    const News = require('../models/News');

    const range = analyticsDateRange(req.query);
    const txMatch = range ? { createdAt: range } : {};
    const newsMatch = range ? { publishedAt: range } : {};

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [txSums, pendingWd, approvedWdInRange, liabilityAgg, newsAgg, activeToday, activeInRange] =
      await Promise.all([
        AdminWalletTransaction.aggregate([
          { $match: txMatch },
          { $group: { _id: '$type', amount: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]),
        WithdrawalRequest.aggregate([
          { $match: { status: 'pending' } },
          { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]),
        WithdrawalRequest.aggregate([
          { $match: { status: 'approved', ...(range ? { processedAt: range } : {}) } },
          { $group: { _id: null, amount: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]),
        Admin.aggregate([
          { $match: { role: 'editor' } },
          { $group: { _id: null, amount: { $sum: '$walletBalance' }, count: { $sum: 1 } } }
        ]),
        News.aggregate([
          { $match: newsMatch },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              approved: { $sum: { $cond: ['$approvalStatus.isApproved', 1, 0] } },
              rejected: { $sum: { $cond: ['$rejectionStatus.isRejected', 1, 0] } },
              views: { $sum: '$views' }
            }
          }
        ]),
        News.distinct('authorId', { publishedAt: { $gte: todayStart } }),
        News.distinct('authorId', newsMatch)
      ]);

    // Count only reporters (role 'editor'), not sub-editors
    const reporterIdDocs = await Admin.find({ role: 'editor' }).select('_id').lean();
    const reporterIdSet = new Set(reporterIdDocs.map((r) => String(r._id)));
    const activeTodayReporters = activeToday.filter((id) => reporterIdSet.has(String(id)));
    const activeInRangeReporters = activeInRange.filter((id) => reporterIdSet.has(String(id)));

    const credits = txSums.find((t) => t._id === 'credit') || { amount: 0, count: 0 };
    const debits = txSums.find((t) => t._id === 'debit') || { amount: 0, count: 0 };
    const news = newsAgg[0] || { total: 0, approved: 0, rejected: 0, views: 0 };
    const earnedReporters = activeInRangeReporters.length || 1;

    res.json({
      earnings: {
        credited: credits.amount,
        creditCount: credits.count,
        debited: debits.amount,
        debitCount: debits.count,
        avgPerActiveReporter: Math.round(credits.amount / earnedReporters)
      },
      withdrawals: {
        pendingCount: pendingWd[0]?.count || 0,
        pendingAmount: pendingWd[0]?.amount || 0,
        paidCount: approvedWdInRange[0]?.count || 0,
        paidAmount: approvedWdInRange[0]?.amount || 0
      },
      wallet: {
        totalLiability: liabilityAgg[0]?.amount || 0,
        reporterCount: liabilityAgg[0]?.count || 0
      },
      news: {
        total: news.total,
        approved: news.approved,
        rejected: news.rejected,
        pending: Math.max(0, news.total - news.approved - news.rejected),
        views: news.views,
        approvalRate: news.total ? Math.round((news.approved / news.total) * 100) : 0
      },
      reporters: {
        activeToday: activeTodayReporters.length,
        activeInRange: activeInRangeReporters.length
      }
    });
  } catch (error) {
    console.error('Error fetching analytics overview:', error);
    res.status(500).json({ error: 'Failed to fetch overview' });
  }
}

// Leaderboard: earnings + posts + approval rate per reporter
async function getReporterLeaderboard(req, res) {
  try {
    const AdminWalletTransaction = require('../models/AdminWalletTransaction');
    const News = require('../models/News');

    const range = analyticsDateRange(req.query);
    const sort = String(req.query.sort || 'earned');
    const limit = Math.min(100, Math.max(5, parseInt(req.query.limit, 10) || 50));

    const [creditAgg, debitAgg, newsAgg, reporters] = await Promise.all([
      AdminWalletTransaction.aggregate([
        { $match: { type: 'credit', ...(range ? { createdAt: range } : {}) } },
        { $group: { _id: '$adminId', amount: { $sum: '$amount' } } }
      ]),
      AdminWalletTransaction.aggregate([
        { $match: { type: 'debit', ...(range ? { createdAt: range } : {}) } },
        { $group: { _id: '$adminId', amount: { $sum: '$amount' } } }
      ]),
      News.aggregate([
        { $match: range ? { publishedAt: range } : {} },
        {
          $group: {
            _id: '$authorId',
            total: { $sum: 1 },
            approved: { $sum: { $cond: ['$approvalStatus.isApproved', 1, 0] } },
            rejected: { $sum: { $cond: ['$rejectionStatus.isRejected', 1, 0] } },
            views: { $sum: '$views' }
          }
        }
      ]),
      Admin.find({ role: 'editor' })
        .select('username name mobileNumber location workingLanguage walletBalance')
        .lean()
    ]);

    const creditMap = new Map(creditAgg.map((c) => [String(c._id), c.amount]));
    const debitMap = new Map(debitAgg.map((d) => [String(d._id), d.amount]));
    const newsMap = new Map(newsAgg.map((n) => [String(n._id), n]));

    let rows = reporters.map((r) => {
      const id = String(r._id);
      const n = newsMap.get(id) || { total: 0, approved: 0, rejected: 0, views: 0 };
      return {
        id,
        name: r.name || r.username,
        username: r.username,
        mobileNumber: r.mobileNumber || '',
        location: r.location || '',
        language: r.workingLanguage || '',
        walletBalance: r.walletBalance || 0,
        earned: creditMap.get(id) || 0,
        withdrawn: debitMap.get(id) || 0,
        posts: n.total,
        approved: n.approved,
        rejected: n.rejected,
        views: n.views,
        approvalRate: n.total ? Math.round((n.approved / n.total) * 100) : 0
      };
    });

    // Hide reporters with zero activity in the selected range (keep for all-time)
    if (range) {
      rows = rows.filter((r) => r.earned > 0 || r.posts > 0 || r.withdrawn > 0);
    }

    const sorters = {
      earned: (a, b) => b.earned - a.earned,
      posts: (a, b) => b.posts - a.posts,
      approved: (a, b) => b.approved - a.approved,
      views: (a, b) => b.views - a.views,
      approvalRate: (a, b) => b.approvalRate - a.approvalRate || b.posts - a.posts,
      balance: (a, b) => b.walletBalance - a.walletBalance
    };
    rows.sort(sorters[sort] || sorters.earned);

    res.json({ reporters: rows.slice(0, limit), totalReporters: reporters.length });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
}

// Location analytics: posts / reporters / views per news location
async function getReporterLocationAnalytics(req, res) {
  try {
    const News = require('../models/News');
    const range = analyticsDateRange(req.query);

    const [newsByLocation, reportersByLocation] = await Promise.all([
      News.aggregate([
        { $match: range ? { publishedAt: range } : {} },
        {
          $group: {
            _id: { $ifNull: ['$location', 'Unknown'] },
            posts: { $sum: 1 },
            approved: { $sum: { $cond: ['$approvalStatus.isApproved', 1, 0] } },
            rejected: { $sum: { $cond: ['$rejectionStatus.isRejected', 1, 0] } },
            views: { $sum: '$views' },
            authors: { $addToSet: '$authorId' }
          }
        },
        { $sort: { posts: -1 } },
        { $limit: 100 }
      ]),
      Admin.aggregate([
        { $match: { role: 'editor' } },
        { $group: { _id: { $ifNull: ['$location', 'Unknown'] }, count: { $sum: 1 } } }
      ])
    ]);

    const registeredMap = new Map(reportersByLocation.map((r) => [String(r._id || 'Unknown'), r.count]));

    res.json({
      locations: newsByLocation.map((l) => ({
        location: l._id || 'Unknown',
        posts: l.posts,
        approved: l.approved,
        rejected: l.rejected,
        views: l.views,
        activeReporters: (l.authors || []).length,
        registeredReporters: registeredMap.get(String(l._id || 'Unknown')) || 0,
        approvalRate: l.posts ? Math.round((l.approved / l.posts) * 100) : 0
      })),
      // Locations that have registered reporters but no posts in range
      silentLocations: reportersByLocation
        .filter((r) => !newsByLocation.some((n) => String(n._id || 'Unknown') === String(r._id || 'Unknown')))
        .map((r) => ({ location: r._id || 'Unknown', registeredReporters: r.count }))
    });
  } catch (error) {
    console.error('Error fetching location analytics:', error);
    res.status(500).json({ error: 'Failed to fetch location analytics' });
  }
}

// Drill-down: one reporter's daily earnings/posts + recent activity
async function getReporterAnalyticsDetail(req, res) {
  try {
    const { id } = req.params;
    const AdminWalletTransaction = require('../models/AdminWalletTransaction');
    const WithdrawalRequest = require('../models/WithdrawalRequest');
    const News = require('../models/News');

    const reporter = await Admin.findById(id)
      .select('username name mobileNumber email location workingLanguage walletBalance createdAt')
      .lean();
    if (!reporter) return res.status(404).json({ error: 'Reporter not found' });

    const days = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 30));
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const dayFmt = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+05:30' } };

    const [dailyCredits, dailyPosts, totals, newsTotals, recentTx, recentWd] = await Promise.all([
      AdminWalletTransaction.aggregate([
        { $match: { adminId: reporter._id, type: 'credit', createdAt: { $gte: since } } },
        { $group: { _id: dayFmt, amount: { $sum: '$amount' } } }
      ]),
      News.aggregate([
        { $match: { authorId: String(reporter._id), publishedAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$publishedAt', timezone: '+05:30' } },
            posts: { $sum: 1 },
            approved: { $sum: { $cond: ['$approvalStatus.isApproved', 1, 0] } }
          }
        }
      ]),
      AdminWalletTransaction.aggregate([
        { $match: { adminId: reporter._id } },
        { $group: { _id: '$type', amount: { $sum: '$amount' } } }
      ]),
      News.aggregate([
        { $match: { authorId: String(reporter._id) } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            approved: { $sum: { $cond: ['$approvalStatus.isApproved', 1, 0] } },
            rejected: { $sum: { $cond: ['$rejectionStatus.isRejected', 1, 0] } },
            views: { $sum: '$views' }
          }
        }
      ]),
      AdminWalletTransaction.find({ adminId: reporter._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('amount type description createdAt balanceAfter')
        .lean(),
      WithdrawalRequest.find({ adminId: reporter._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .select('amount status createdAt processedAt remarks utr')
        .lean()
    ]);

    const creditByDay = new Map(dailyCredits.map((d) => [d._id, d.amount]));
    const postsByDay = new Map(dailyPosts.map((d) => [d._id, d]));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
      const p = postsByDay.get(key) || { posts: 0, approved: 0 };
      series.push({ date: key, earned: creditByDay.get(key) || 0, posts: p.posts, approved: p.approved });
    }

    const news = newsTotals[0] || { total: 0, approved: 0, rejected: 0, views: 0 };

    res.json({
      reporter: {
        id: reporter._id,
        name: reporter.name || reporter.username,
        username: reporter.username,
        mobileNumber: reporter.mobileNumber || '',
        email: reporter.email || '',
        location: reporter.location || '',
        language: reporter.workingLanguage || '',
        walletBalance: reporter.walletBalance || 0,
        joinedAt: reporter.createdAt
      },
      totals: {
        earned: totals.find((t) => t._id === 'credit')?.amount || 0,
        withdrawn: totals.find((t) => t._id === 'debit')?.amount || 0,
        posts: news.total,
        approved: news.approved,
        rejected: news.rejected,
        views: news.views,
        approvalRate: news.total ? Math.round((news.approved / news.total) * 100) : 0
      },
      series,
      recentTransactions: recentTx.map((t) => ({
        amount: t.amount,
        type: t.type,
        description: t.description,
        balanceAfter: t.balanceAfter,
        createdAt: t.createdAt
      })),
      recentWithdrawals: recentWd.map((w) => ({
        amount: w.amount,
        status: w.status,
        utr: w.utr || '',
        remarks: w.remarks || '',
        createdAt: w.createdAt,
        processedAt: w.processedAt
      }))
    });
  } catch (error) {
    console.error('Error fetching reporter detail:', error);
    res.status(500).json({ error: 'Failed to fetch reporter detail' });
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — Fraud detection & account controls
// ---------------------------------------------------------------------------

async function renderFraudAlertsPage(req, res) {
  try {
    res.render('fraud-alerts', {
      title: 'Fraud Alerts',
      admin: req.admin,
      activePage: 'fraud-alerts'
    });
  } catch (error) {
    console.error('Error rendering fraud alerts page:', error);
    res.status(500).send('Error loading page');
  }
}

// All fraud signals in one call (computed on demand over last N days)
async function getFraudAlerts(req, res) {
  try {
    const News = require('../models/News');
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const reporters = await Admin.find({ role: { $in: ['editor', 'subeditor'] } })
      .select('username name mobileNumber location walletBalance walletFrozen isActive loginHistory')
      .lean();
    const reporterMap = new Map(reporters.map((r) => [String(r._id), r]));
    const reporterInfo = (id) => {
      const r = reporterMap.get(String(id));
      return r
        ? {
            id: String(r._id),
            name: r.name || r.username,
            mobileNumber: r.mobileNumber || '',
            location: r.location || '',
            walletFrozen: !!r.walletFrozen,
            isActive: r.isActive !== false
          }
        : null;
    };

    // 1) Post spikes: today's posts vs daily average over the window
    const dailyPosts = await News.aggregate([
      { $match: { publishedAt: { $gte: since } } },
      {
        $group: {
          _id: {
            author: '$authorId',
            day: { $dateToString: { format: '%Y-%m-%d', date: '$publishedAt', timezone: '+05:30' } }
          },
          posts: { $sum: 1 }
        }
      }
    ]);
    const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const perAuthor = new Map();
    dailyPosts.forEach((d) => {
      const a = String(d._id.author);
      if (!perAuthor.has(a)) perAuthor.set(a, { today: 0, otherDays: [] });
      const rec = perAuthor.get(a);
      if (d._id.day === todayKey) rec.today = d.posts;
      else rec.otherDays.push(d.posts);
    });
    const postSpikes = [];
    perAuthor.forEach((rec, author) => {
      const info = reporterInfo(author);
      if (!info) return;
      const avg = rec.otherDays.length
        ? rec.otherDays.reduce((s, n) => s + n, 0) / rec.otherDays.length
        : 0;
      if (rec.today >= 5 && (avg === 0 || rec.today >= avg * 3)) {
        postSpikes.push({
          reporter: info,
          todayPosts: rec.today,
          dailyAverage: Math.round(avg * 10) / 10
        });
      }
    });
    postSpikes.sort((a, b) => b.todayPosts - a.todayPosts);

    // 2) Same media reused by multiple reporters
    const dupMedia = await News.aggregate([
      { $match: { publishedAt: { $gte: since }, mediaUrl: { $exists: true, $nin: [null, ''] } } },
      {
        $group: {
          _id: '$mediaUrl',
          count: { $sum: 1 },
          authors: { $addToSet: '$authorId' },
          titles: { $push: '$title' }
        }
      },
      { $match: { $expr: { $gt: [{ $size: '$authors' }, 1] } } },
      { $sort: { count: -1 } },
      { $limit: 30 }
    ]);
    const duplicateMedia = dupMedia.map((m) => ({
      mediaUrl: m._id,
      usedCount: m.count,
      reporters: m.authors.map(reporterInfo).filter(Boolean),
      sampleTitles: (m.titles || []).slice(0, 3)
    }));

    // 3) Same content hash by multiple reporters (copy-paste rings)
    const dupContent = await News.aggregate([
      { $match: { publishedAt: { $gte: since }, contentHash: { $exists: true, $nin: [null, ''] } } },
      {
        $group: {
          _id: '$contentHash',
          count: { $sum: 1 },
          authors: { $addToSet: '$authorId' },
          titles: { $push: '$title' }
        }
      },
      { $match: { $expr: { $gt: [{ $size: '$authors' }, 1] } } },
      { $sort: { count: -1 } },
      { $limit: 30 }
    ]);
    const duplicateContent = dupContent.map((c) => ({
      usedCount: c.count,
      reporters: c.authors.map(reporterInfo).filter(Boolean),
      sampleTitles: (c.titles || []).slice(0, 3)
    }));

    // 4) Shared login IPs across reporter accounts
    const ipMap = new Map();
    reporters.forEach((r) => {
      const ips = new Set((r.loginHistory || []).map((h) => h.ip).filter(Boolean));
      ips.forEach((ip) => {
        if (!ipMap.has(ip)) ipMap.set(ip, []);
        ipMap.get(ip).push(String(r._id));
      });
    });
    const sharedIps = [];
    ipMap.forEach((ids, ip) => {
      if (ids.length > 1) {
        sharedIps.push({ ip, reporters: ids.map(reporterInfo).filter(Boolean) });
      }
    });
    sharedIps.sort((a, b) => b.reporters.length - a.reporters.length);

    // 5) Location mismatch: posts mostly from a different area than registered
    const postLocations = await News.aggregate([
      { $match: { publishedAt: { $gte: since }, location: { $exists: true, $nin: [null, ''] } } },
      {
        $group: {
          _id: { author: '$authorId', location: '$location' },
          posts: { $sum: 1 }
        }
      }
    ]);
    const authorLocations = new Map();
    postLocations.forEach((p) => {
      const a = String(p._id.author);
      if (!authorLocations.has(a)) authorLocations.set(a, []);
      authorLocations.get(a).push({ location: p._id.location, posts: p.posts });
    });
    const locationMismatches = [];
    authorLocations.forEach((locs, author) => {
      const r = reporterMap.get(author);
      if (!r || !r.location) return;
      const total = locs.reduce((s, l) => s + l.posts, 0);
      const outside = locs.filter(
        (l) => String(l.location).toLowerCase() !== String(r.location).toLowerCase()
      );
      const outsidePosts = outside.reduce((s, l) => s + l.posts, 0);
      if (total >= 3 && outsidePosts / total >= 0.6) {
        const top = [...locs].sort((a, b) => b.posts - a.posts)[0];
        locationMismatches.push({
          reporter: reporterInfo(author),
          registeredLocation: r.location,
          topPostingLocation: top.location,
          outsidePosts,
          totalPosts: total,
          outsidePercent: Math.round((outsidePosts / total) * 100)
        });
      }
    });
    locationMismatches.sort((a, b) => b.outsidePercent - a.outsidePercent);

    // 6) Plagiarism repeaters (system duplicate checker flags)
    const plagAgg = await News.aggregate([
      {
        $match: {
          publishedAt: { $gte: since },
          $or: [{ 'duplicateCheck.isDuplicate': true }, { 'duplicateCheck.isSuspicious': true }]
        }
      },
      { $group: { _id: '$authorId', flagged: { $sum: 1 } } },
      { $match: { flagged: { $gte: 2 } } },
      { $sort: { flagged: -1 } },
      { $limit: 30 }
    ]);
    const plagiarismRepeaters = plagAgg
      .map((p) => ({ reporter: reporterInfo(p._id), flaggedPosts: p.flagged }))
      .filter((p) => p.reporter);

    res.json({
      days,
      summary: {
        postSpikes: postSpikes.length,
        duplicateMedia: duplicateMedia.length,
        duplicateContent: duplicateContent.length,
        sharedIps: sharedIps.length,
        locationMismatches: locationMismatches.length,
        plagiarismRepeaters: plagiarismRepeaters.length
      },
      postSpikes,
      duplicateMedia,
      duplicateContent,
      sharedIps,
      locationMismatches,
      plagiarismRepeaters
    });
  } catch (error) {
    console.error('Error computing fraud alerts:', error);
    res.status(500).json({ error: 'Failed to compute fraud alerts' });
  }
}

// ---------------------------------------------------------------------------
// News geography map (state / district choropleth)
// ---------------------------------------------------------------------------

async function renderNewsMapPage(req, res) {
  try {
    res.render('news-map', {
      title: 'News Map',
      admin: req.admin,
      activePage: 'news-map'
    });
  } catch (error) {
    console.error('Error rendering news map page:', error);
    res.status(500).send('Error loading page');
  }
}

// Counts of news per location, classified into states / districts / scopes
async function getNewsMapData(req, res) {
  try {
    const News = require('../models/News');
    const Location = require('../models/Location');

    const days = parseInt(req.query.days, 10) || 0; // 0 = all time
    const match = {};
    if (days > 0) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      since.setHours(0, 0, 0, 0);
      match.publishedAt = { $gte: since };
    }

    const [locCounts, locationDocs] = await Promise.all([
      News.aggregate([
        { $match: match },
        { $group: { _id: '$location', count: { $sum: 1 } } }
      ]),
      Location.find({}).select('name locationType parentName').lean()
    ]);

    // name (lowercase) -> { type, parent }
    const locIndex = new Map();
    locationDocs.forEach((l) => {
      locIndex.set(String(l.name).trim().toLowerCase(), {
        name: l.name,
        type: l.locationType,
        parent: l.parentName || null
      });
    });

    // Hierarchy: state -> { direct, total, districts: { name: { direct, total, constituencies: {} } } }
    const states = {};
    const scopes = {}; // National / International
    let unknown = 0;
    const unmatched = [];

    const ensureState = (name) => {
      if (!states[name]) states[name] = { total: 0, direct: 0, districts: {} };
      return states[name];
    };
    const ensureDistrict = (stateName, districtName) => {
      const s = ensureState(stateName);
      if (!s.districts[districtName]) {
        s.districts[districtName] = { direct: 0, total: 0, constituencies: {} };
      }
      return s.districts[districtName];
    };
    // Constituency parent = district name; district parent = state name
    const stateOfDistrict = (districtName) => {
      const d = locIndex.get(String(districtName || '').trim().toLowerCase());
      return d && d.type === 'district' ? d.parent : null;
    };

    locCounts.forEach(({ _id, count }) => {
      const raw = String(_id || '').trim();
      if (!raw) {
        unknown += count;
        return;
      }
      const info = locIndex.get(raw.toLowerCase());
      if (info && info.type === 'state') {
        ensureState(info.name).direct += count;
      } else if (info && info.type === 'district' && info.parent) {
        ensureDistrict(info.parent, info.name).direct += count;
      } else if (info && info.type === 'constituency' && info.parent) {
        const stateName = stateOfDistrict(info.parent);
        if (stateName) {
          const d = ensureDistrict(stateName, info.parent);
          d.constituencies[info.name] = (d.constituencies[info.name] || 0) + count;
        } else {
          unmatched.push({ name: raw, count });
        }
      } else if (info && info.type === 'scope') {
        scopes[info.name] = (scopes[info.name] || 0) + count;
      } else if (raw.toLowerCase() === 'national' || raw.toLowerCase() === 'international') {
        const key = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
        scopes[key] = (scopes[key] || 0) + count;
      } else {
        unmatched.push({ name: raw, count });
      }
    });

    // Roll-up totals: constituency -> district -> state
    Object.values(states).forEach((s) => {
      Object.values(s.districts).forEach((d) => {
        const constTotal = Object.values(d.constituencies).reduce((sum, c) => sum + c, 0);
        d.total = d.direct + constTotal;
      });
      const distTotal = Object.values(s.districts).reduce((sum, d) => sum + d.total, 0);
      s.total = s.direct + distTotal;
    });

    unmatched.sort((a, b) => b.count - a.count);

    res.json({
      days,
      states,
      scopes,
      unknown,
      unmatched,
      totalNews: locCounts.reduce((s, l) => s + l.count, 0)
    });
  } catch (error) {
    console.error('Error building news map data:', error);
    res.status(500).json({ error: 'Failed to build news map data' });
  }
}

// Drill-down: which news posts mismatch the reporter's registered location
async function getFraudLocationPosts(req, res) {
  try {
    const News = require('../models/News');
    const { id } = req.params;
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const reporter = await Admin.findById(id).select('username name location').lean();
    if (!reporter) return res.status(404).json({ error: 'Reporter not found' });

    const registered = String(reporter.location || '').trim();
    const registeredLc = registered.toLowerCase();

    const posts = await News.find({ authorId: String(id), publishedAt: { $gte: since } })
      .select('title location publishedAt isActive approvalStatus rejectionStatus views')
      .sort({ publishedAt: -1 })
      .limit(200)
      .lean();

    const rows = posts.map((p) => {
      const loc = String(p.location || '').trim();
      let status = 'pending';
      if (p.rejectionStatus?.isRejected) status = 'rejected';
      else if (p.approvalStatus?.isApproved || p.isActive) status = 'approved';
      return {
        id: String(p._id),
        title: p.title || '(no title)',
        location: loc || '(location ledu)',
        publishedAt: p.publishedAt,
        status,
        views: p.views || 0,
        mismatch: !registeredLc || loc.toLowerCase() !== registeredLc
      };
    });

    res.json({
      reporter: { id: String(reporter._id), name: reporter.name || reporter.username },
      registeredLocation: registered || '(register avvaledu)',
      days,
      totalPosts: rows.length,
      mismatchPosts: rows.filter((r) => r.mismatch).length,
      posts: rows
    });
  } catch (error) {
    console.error('Error fetching location posts:', error);
    res.status(500).json({ error: 'Failed to fetch location posts' });
  }
}

// Freeze / unfreeze a reporter's wallet (balance stays, withdrawals blocked)
async function setWalletFreeze(req, res) {
  try {
    const { id } = req.params;
    const freeze = !!req.body.freeze;
    const reason = String(req.body.reason || '').trim();

    if (freeze && reason.length < 5) {
      return res.status(400).json({ error: 'Freeze reason is mandatory (min 5 characters)' });
    }

    const reporter = await Admin.findById(id).select('username name walletFrozen walletFreezeReason');
    if (!reporter) return res.status(404).json({ error: 'Reporter not found' });

    const before = { walletFrozen: !!reporter.walletFrozen, walletFreezeReason: reporter.walletFreezeReason || '' };
    reporter.walletFrozen = freeze;
    reporter.walletFreezeReason = freeze ? reason : '';
    await reporter.save();

    const { logAudit } = require('../utils/auditLogger');
    logAudit({
      req,
      action: freeze ? 'wallet_freeze' : 'wallet_unfreeze',
      entityType: 'Admin',
      entityId: reporter._id,
      targetId: reporter._id,
      targetName: reporter.name || reporter.username,
      description: freeze
        ? `Wallet frozen — ${reason}`
        : 'Wallet unfrozen',
      before,
      after: { walletFrozen: freeze, walletFreezeReason: reporter.walletFreezeReason }
    });

    res.json({
      success: true,
      message: `Wallet ${freeze ? 'frozen' : 'unfrozen'} for ${reporter.name || reporter.username}`
    });
  } catch (error) {
    console.error('Error setting wallet freeze:', error);
    res.status(500).json({ error: 'Failed to update wallet freeze' });
  }
}

// Suspend / activate a reporter account (login blocked when suspended)
async function setReporterSuspension(req, res) {
  try {
    const { id } = req.params;
    const suspend = !!req.body.suspend;
    const reason = String(req.body.reason || '').trim();

    if (suspend && reason.length < 5) {
      return res.status(400).json({ error: 'Suspension reason is mandatory (min 5 characters)' });
    }

    const reporter = await Admin.findById(id).select('username name isActive role');
    if (!reporter) return res.status(404).json({ error: 'Reporter not found' });
    if (['admin', 'superadmin'].includes(reporter.role)) {
      return res.status(400).json({ error: 'Cannot suspend an admin account from here' });
    }

    const before = { isActive: reporter.isActive !== false };
    reporter.isActive = !suspend;
    await reporter.save();

    const { logAudit } = require('../utils/auditLogger');
    logAudit({
      req,
      action: suspend ? 'reporter_suspend' : 'reporter_activate',
      entityType: 'Admin',
      entityId: reporter._id,
      targetId: reporter._id,
      targetName: reporter.name || reporter.username,
      description: suspend ? `Account suspended — ${reason}` : 'Account re-activated',
      before,
      after: { isActive: !suspend }
    });

    res.json({
      success: true,
      message: `Account ${suspend ? 'suspended' : 're-activated'} for ${reporter.name || reporter.username}`
    });
  } catch (error) {
    console.error('Error setting suspension:', error);
    res.status(500).json({ error: 'Failed to update account status' });
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — Engagement (streaks, badges, rank) + monthly reports
// ---------------------------------------------------------------------------

const BADGE_DEFS = [
  { id: 'posts_10', group: 'Posts', label: 'Starter', icon: '📰', metric: 'approved', threshold: 10 },
  { id: 'posts_50', group: 'Posts', label: 'Rising Star', icon: '⭐', metric: 'approved', threshold: 50 },
  { id: 'posts_100', group: 'Posts', label: 'Century', icon: '💯', metric: 'approved', threshold: 100 },
  { id: 'posts_500', group: 'Posts', label: 'Veteran', icon: '🏅', metric: 'approved', threshold: 500 },
  { id: 'posts_1000', group: 'Posts', label: 'Legend', icon: '👑', metric: 'approved', threshold: 1000 },
  { id: 'views_10k', group: 'Views', label: '10K Views', icon: '👀', metric: 'views', threshold: 10000 },
  { id: 'views_1l', group: 'Views', label: '1 Lakh Views', icon: '🔥', metric: 'views', threshold: 100000 },
  { id: 'views_10l', group: 'Views', label: '10 Lakh Views', icon: '🚀', metric: 'views', threshold: 1000000 },
  { id: 'earn_1k', group: 'Earnings', label: '₹1,000 Club', icon: '💰', metric: 'earned', threshold: 1000 },
  { id: 'earn_5k', group: 'Earnings', label: '₹5,000 Club', icon: '💎', metric: 'earned', threshold: 5000 },
  { id: 'earn_10k', group: 'Earnings', label: '₹10,000 Club', icon: '🏆', metric: 'earned', threshold: 10000 }
];

// Reporter app: streak, badges, monthly rank
async function getReporterEngagement(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const AdminWalletTransaction = require('../models/AdminWalletTransaction');
    const News = require('../models/News');

    const engagementAdmin = await Admin.findById(reporterId).select('walletConfig').lean();
    const walletOn = engagementAdmin?.walletConfig?.enabled === true;

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [rewardDays, newsTotals, earnedTotal, monthCredits] = await Promise.all([
      // Days on which the daily target was hit (daily reward credited)
      AdminWalletTransaction.aggregate([
        {
          $match: {
            adminId: new mongoose.Types.ObjectId(String(reporterId)),
            type: 'credit',
            referenceId: { $regex: '^reward_' }
          }
        },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+05:30' } }
          }
        }
      ]),
      News.aggregate([
        { $match: { authorId: String(reporterId) } },
        {
          $group: {
            _id: null,
            approved: { $sum: { $cond: ['$approvalStatus.isApproved', 1, 0] } },
            views: { $sum: '$views' }
          }
        }
      ]),
      AdminWalletTransaction.aggregate([
        { $match: { adminId: new mongoose.Types.ObjectId(String(reporterId)), type: 'credit' } },
        { $group: { _id: null, amount: { $sum: '$amount' } } }
      ]),
      // This month's credits for all reporters (for rank)
      AdminWalletTransaction.aggregate([
        { $match: { type: 'credit', createdAt: { $gte: monthStart } } },
        { $group: { _id: '$adminId', amount: { $sum: '$amount' } } },
        { $sort: { amount: -1 } }
      ])
    ]);

    // ---- Streak calculation (IST days) ----
    const daySet = new Set(rewardDays.map((d) => d._id));
    const istDay = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() - offset);
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
    };

    let currentStreak = 0;
    // Today counts if already credited; otherwise streak continues from yesterday
    let offset = daySet.has(istDay(0)) ? 0 : 1;
    while (daySet.has(istDay(offset))) {
      currentStreak++;
      offset++;
    }

    let bestStreak = 0;
    const sortedDays = [...daySet].sort();
    let run = 0;
    let prev = null;
    sortedDays.forEach((day) => {
      if (prev) {
        const diff = (new Date(day) - new Date(prev)) / 86400000;
        run = diff === 1 ? run + 1 : 1;
      } else {
        run = 1;
      }
      if (run > bestStreak) bestStreak = run;
      prev = day;
    });

    // ---- Badges ----
    const stats = {
      approved: newsTotals[0]?.approved || 0,
      views: newsTotals[0]?.views || 0,
      earned: earnedTotal[0]?.amount || 0
    };
    // Wallet OFF unna reporter ki earnings related badges/rank kanipiyyavu
    const badges = BADGE_DEFS
      .filter((b) => walletOn || b.group !== 'Earnings')
      .map((b) => ({
        id: b.id,
        group: b.group,
        label: b.label,
        icon: b.icon,
        threshold: b.threshold,
        earned: stats[b.metric] >= b.threshold,
        progress: Math.min(100, Math.round((stats[b.metric] / b.threshold) * 100)),
        current: stats[b.metric]
      }));

    // ---- Month rank ----
    const rankIndex = monthCredits.findIndex((c) => String(c._id) === String(reporterId));

    res.json({
      walletEnabled: walletOn,
      streak: {
        current: currentStreak,
        best: bestStreak,
        targetDaysTotal: daySet.size
      },
      badges,
      earnedBadgeCount: badges.filter((b) => b.earned).length,
      monthRank: walletOn && rankIndex >= 0 ? rankIndex + 1 : null,
      monthEarned: walletOn && rankIndex >= 0 ? monthCredits[rankIndex].amount : 0,
      totals: stats
    });
  } catch (error) {
    console.error('Error fetching engagement:', error);
    res.status(500).json({ error: 'Failed to fetch engagement' });
  }
}

async function renderMonthlyReportPage(req, res) {
  try {
    res.render('monthly-report', {
      title: 'Monthly Report',
      admin: req.admin,
      activePage: 'monthly-report'
    });
  } catch (error) {
    console.error('Error rendering monthly report page:', error);
    res.status(500).send('Error loading page');
  }
}

// Admin: month-wise reporter earnings/payout report (JSON or CSV)
async function getMonthlyReport(req, res) {
  try {
    const AdminWalletTransaction = require('../models/AdminWalletTransaction');
    const WithdrawalRequest = require('../models/WithdrawalRequest');
    const News = require('../models/News');

    const month = String(req.query.month || '').trim(); // YYYY-MM
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }
    const from = new Date(`${month}-01T00:00:00.000+05:30`);
    const to = new Date(from);
    to.setMonth(to.getMonth() + 1);

    const txRange = { createdAt: { $gte: from, $lt: to } };

    const [creditAgg, debitAgg, paidWdAgg, newsAgg, reporters] = await Promise.all([
      AdminWalletTransaction.aggregate([
        { $match: { type: 'credit', ...txRange } },
        { $group: { _id: '$adminId', amount: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      AdminWalletTransaction.aggregate([
        { $match: { type: 'debit', ...txRange } },
        { $group: { _id: '$adminId', amount: { $sum: '$amount' } } }
      ]),
      WithdrawalRequest.aggregate([
        { $match: { status: 'approved', processedAt: { $gte: from, $lt: to } } },
        { $group: { _id: '$adminId', amount: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]),
      News.aggregate([
        { $match: { publishedAt: { $gte: from, $lt: to } } },
        {
          $group: {
            _id: '$authorId',
            posts: { $sum: 1 },
            approved: { $sum: { $cond: ['$approvalStatus.isApproved', 1, 0] } },
            rejected: { $sum: { $cond: ['$rejectionStatus.isRejected', 1, 0] } },
            views: { $sum: '$views' }
          }
        }
      ]),
      Admin.find({ role: { $in: ['editor', 'subeditor'] } })
        .select('username name mobileNumber location workingLanguage walletBalance')
        .lean()
    ]);

    const creditMap = new Map(creditAgg.map((c) => [String(c._id), c]));
    const debitMap = new Map(debitAgg.map((d) => [String(d._id), d.amount]));
    const paidMap = new Map(paidWdAgg.map((p) => [String(p._id), p]));
    const newsMap = new Map(newsAgg.map((n) => [String(n._id), n]));

    const rows = reporters
      .map((r) => {
        const id = String(r._id);
        const credit = creditMap.get(id);
        const news = newsMap.get(id);
        const paid = paidMap.get(id);
        return {
          id,
          name: r.name || r.username,
          mobileNumber: r.mobileNumber || '',
          location: r.location || '',
          language: (r.workingLanguage || '').toUpperCase(),
          earned: credit?.amount || 0,
          debited: debitMap.get(id) || 0,
          paidOut: paid?.amount || 0,
          payoutCount: paid?.count || 0,
          posts: news?.posts || 0,
          approved: news?.approved || 0,
          rejected: news?.rejected || 0,
          views: news?.views || 0,
          currentBalance: r.walletBalance || 0
        };
      })
      .filter((r) => r.earned > 0 || r.posts > 0 || r.paidOut > 0)
      .sort((a, b) => b.earned - a.earned);

    const totals = rows.reduce(
      (acc, r) => {
        acc.earned += r.earned;
        acc.paidOut += r.paidOut;
        acc.posts += r.posts;
        acc.approved += r.approved;
        acc.views += r.views;
        return acc;
      },
      { earned: 0, paidOut: 0, posts: 0, approved: 0, views: 0 }
    );

    if (String(req.query.format || '') === 'csv') {
      const escCsv = (v) => {
        const s = String(v == null ? '' : v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const lines = [
        ['Reporter', 'Mobile', 'Location', 'Language', 'Earned', 'Paid Out', 'Payouts', 'Posts', 'Approved', 'Rejected', 'Views', 'Current Balance'].join(',')
      ];
      rows.forEach((r) => {
        lines.push(
          [r.name, r.mobileNumber, r.location, r.language, r.earned, r.paidOut, r.payoutCount, r.posts, r.approved, r.rejected, r.views, r.currentBalance]
            .map(escCsv)
            .join(',')
        );
      });
      lines.push(['TOTAL', '', '', '', totals.earned, totals.paidOut, '', totals.posts, totals.approved, '', totals.views, ''].join(','));

      const { logAudit } = require('../utils/auditLogger');
      logAudit({
        req,
        action: 'monthly_report_export',
        entityType: 'Report',
        description: `Exported monthly report for ${month} (${rows.length} reporters)`
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="reporter-report-${month}.csv"`);
      return res.send('\uFEFF' + lines.join('\n'));
    }

    if (String(req.query.format || '') === 'pdf') {
      const { streamPdfReport, pdfFilename } = require('../utils/pdfReportExport');
      const columns = [
        'Reporter',
        'Mobile',
        'Location',
        'Language',
        'Earned',
        'Paid Out',
        'Payouts',
        'Posts',
        'Approved',
        'Rejected',
        'Views',
        'Current Balance'
      ];
      const tableRows = rows.map((r) => [
        r.name,
        r.mobileNumber,
        r.location,
        r.language,
        r.earned,
        r.paidOut,
        r.payoutCount,
        r.posts,
        r.approved,
        r.rejected,
        r.views,
        r.currentBalance
      ]);
      tableRows.push([
        'TOTAL',
        '',
        '',
        '',
        totals.earned,
        totals.paidOut,
        '',
        totals.posts,
        totals.approved,
        '',
        totals.views,
        ''
      ]);

      const { logAudit } = require('../utils/auditLogger');
      logAudit({
        req,
        action: 'monthly_report_export',
        entityType: 'Report',
        description: `Exported monthly report PDF for ${month} (${rows.length} reporters)`
      });

      const adminName = req.admin?.name || req.admin?.username || 'Admin';
      return streamPdfReport({
        res,
        filename: pdfFilename('reporter-report', month),
        title: `Monthly Reporter Report — ${month}`,
        adminName,
        dateRange: month,
        columns,
        rows: tableRows,
        totalRecords: rows.length
      });
    }

    res.json({ month, totals, reporterCount: rows.length, rows });
  } catch (error) {
    console.error('Error building monthly report:', error);
    res.status(500).json({ error: 'Failed to build monthly report' });
  }
}

// Admin: searchable audit log
async function listAuditLogs(req, res) {
  try {
    const AuditLog = require('../models/AuditLog');
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.action) filter.action = req.query.action;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = new Date(`${req.query.from}T00:00:00.000+05:30`);
      if (req.query.to) filter.createdAt.$lte = new Date(`${req.query.to}T23:59:59.999+05:30`);
    }
    const q = String(req.query.q || '').trim();
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ actorName: rx }, { targetName: rx }, { description: rx }];
    }

    const [logs, total, actions] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
      AuditLog.distinct('action')
    ]);

    res.json({
      page,
      limit,
      total,
      actions: actions.sort(),
      logs: logs.map((l) => ({
        id: l._id,
        actorName: l.actorName,
        actorRole: l.actorRole,
        action: l.action,
        entityType: l.entityType,
        entityId: l.entityId,
        targetName: l.targetName,
        description: l.description,
        before: l.before,
        after: l.after,
        ip: l.ip,
        createdAt: l.createdAt
      }))
    });
  } catch (error) {
    console.error('Error listing audit logs:', error);
    res.status(500).json({ error: 'Failed to list audit logs' });
  }
}

const DEFAULT_REPORTER_HOME = {
  te: {
    title: 'ShortNews',
    titleHighlight: 'రిపోర్టర్',
    message:
      'గమనిక: కాపీ వార్తలు పబ్లిష్ చేయబడవు. కాపీ వార్తలు పంపితే లీగల్‌గా రిపోర్టర్లదే బాధ్యత. అలాగే వార్తను పంపేముందు ఎప్పుడు, ఎక్కడ జరిగిందో నిర్ధారించుకోగలరు',
    card1: {
      number: '1',
      title: 'Sr Reporter',
      subtitle: 'న్యూస్ పోస్ట్ చేసి ఆదాయం పొందండి',
      cta: 'న్యూస్ పోస్ట్ చేయండి',
      href: '/post',
      imageUrl: ''
    },
    card2: {
      number: '2',
      title: 'అదనపు ఆదాయం కొరకు',
      subtitle: 'ఇన్సూరేషన్ ఇవ్వండి అదనపు ఆదాయం పొందండి',
      cta: 'ఎలాగో తెలుసుకోండి',
      href: '/earning',
      imageUrl: ''
    }
  },
  en: {
    title: 'ShortNews',
    titleHighlight: 'Reporter',
    message:
      'Note: Copied news will not be published. Reporters are legally responsible for copied news. Before sending news, please confirm when and where it happened.',
    card1: {
      number: '1',
      title: 'Sr Reporter',
      subtitle: 'Post news and earn income',
      cta: 'Post News',
      href: '/post',
      imageUrl: ''
    },
    card2: {
      number: '2',
      title: 'For Extra Income',
      subtitle: 'Give insurance and earn extra income',
      cta: 'Learn how',
      href: '/earning',
      imageUrl: ''
    }
  },
  hi: {
    title: 'ShortNews',
    titleHighlight: 'रिपोर्टर',
    message:
      'नोट: कॉपी की गई खबरें पब्लिश नहीं होंगी। कॉपी खबर भेजने पर कानूनी ज़िम्मेदारी रिपोर्टर की होगी। खबर भेजने से पहले कब और कहाँ हुई, पुष्टि कर लें।',
    card1: {
      number: '1',
      title: 'Sr Reporter',
      subtitle: 'न्यूज़ पोस्ट करें और कमाई पाएं',
      cta: 'न्यूज़ पोस्ट करें',
      href: '/post',
      imageUrl: ''
    },
    card2: {
      number: '2',
      title: 'अतिरिक्त आय के लिए',
      subtitle: 'इंश्योरेंस दें और अतिरिक्त आय पाएं',
      cta: 'जानें कैसे',
      href: '/earning',
      imageUrl: ''
    }
  }
};

function normalizeHomeCard(card, fallback) {
  const src = card && typeof card === 'object' ? card : {};
  const fb = fallback || {};
  return {
    number: String(src.number != null ? src.number : fb.number || '1').trim() || fb.number || '1',
    title: String(src.title != null ? src.title : fb.title || '').trim(),
    subtitle: String(src.subtitle != null ? src.subtitle : fb.subtitle || '').trim(),
    cta: String(src.cta != null ? src.cta : fb.cta || '').trim(),
    href: String(src.href != null ? src.href : fb.href || '/').trim() || '/',
    imageUrl: String(src.imageUrl != null ? src.imageUrl : fb.imageUrl || '').trim()
  };
}

function getDefaultReporterHome(language) {
  const code = String(language || 'te').toLowerCase();
  const base = DEFAULT_REPORTER_HOME[code] || {
    title: 'ShortNews',
    titleHighlight: 'Reporter',
    message: DEFAULT_REPORTER_HOME.en.message,
    card1: DEFAULT_REPORTER_HOME.en.card1,
    card2: DEFAULT_REPORTER_HOME.en.card2
  };
  return {
    title: base.title,
    titleHighlight: base.titleHighlight,
    message: base.message,
    card1: { ...base.card1 },
    card2: { ...base.card2 }
  };
}

function mergeReporterHomeDoc(doc, language) {
  const fallback = getDefaultReporterHome(language);
  return {
    language: doc?.language || language,
    title: doc?.title || fallback.title,
    titleHighlight: doc?.titleHighlight || fallback.titleHighlight,
    message: doc?.message || fallback.message,
    card1: normalizeHomeCard(doc?.card1, fallback.card1),
    card2: normalizeHomeCard(doc?.card2, fallback.card2)
  };
}

async function renderReporterHomeContentPage(req, res) {
  try {
    const { getActiveLanguages } = require('../services/languageRegistry');
    res.render('reporter-home-content', {
      title: 'Reporter Home Content',
      admin: req.admin,
      activePage: 'reporter-home-content',
      languages: getActiveLanguages()
    });
  } catch (error) {
    console.error('Error rendering reporter home content page:', error);
    res.status(500).send('Error loading page');
  }
}

async function getReporterHomeContentAdmin(req, res) {
  try {
    const { getActiveLanguages } = require('../services/languageRegistry');
    const ReporterHomeContent = require('../models/ReporterHomeContent');
    const languages = getActiveLanguages();
    const docs = await ReporterHomeContent.find({}).lean();
    const byLang = {};
    docs.forEach((d) => {
      byLang[d.language] = d;
    });

    const items = languages.map((lang) => {
      const saved = byLang[lang.code];
      const merged = mergeReporterHomeDoc(saved, lang.code);
      return {
        ...merged,
        name: lang.name,
        nativeName: lang.nativeName,
        isSaved: !!saved
      };
    });

    res.json({ items });
  } catch (error) {
    console.error('Error fetching reporter home content:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
}

async function updateReporterHomeContentAdmin(req, res) {
  try {
    const { language, title, titleHighlight, message, card1, card2 } = req.body || {};
    const code = String(language || '')
      .trim()
      .toLowerCase();
    if (!code) {
      return res.status(400).json({ error: 'Language is required' });
    }

    const { getActiveLanguages } = require('../services/languageRegistry');
    const active = getActiveLanguages().some((l) => l.code === code);
    if (!active) {
      return res.status(400).json({ error: 'Language is not active in admin languages' });
    }

    const fallback = getDefaultReporterHome(code);
    const ReporterHomeContent = require('../models/ReporterHomeContent');
    const doc = await ReporterHomeContent.findOneAndUpdate(
      { language: code },
      {
        language: code,
        title: String(title || 'ShortNews').trim(),
        titleHighlight: String(titleHighlight || '').trim(),
        message: String(message || '').trim(),
        card1: normalizeHomeCard(card1, fallback.card1),
        card2: normalizeHomeCard(card2, fallback.card2)
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      success: true,
      item: mergeReporterHomeDoc(doc.toObject ? doc.toObject() : doc, code)
    });
  } catch (error) {
    console.error('Error updating reporter home content:', error);
    res.status(500).json({ error: 'Failed to save content' });
  }
}

/** Reporter app: home banner + 2 cards for working language */
async function getReporterHomeBanner(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const admin = await Admin.findById(reporterId).select('workingLanguage').lean();
    let lang = String(admin?.workingLanguage || req.query.language || 'te')
      .trim()
      .toLowerCase();
    if (!lang) lang = 'te';

    const ReporterHomeContent = require('../models/ReporterHomeContent');
    let doc = await ReporterHomeContent.findOne({ language: lang }).lean();
    if (!doc && lang !== 'en') {
      doc = await ReporterHomeContent.findOne({ language: 'en' }).lean();
    }
    if (!doc && lang !== 'te') {
      doc = await ReporterHomeContent.findOne({ language: 'te' }).lean();
    }

    res.json(mergeReporterHomeDoc(doc, lang));
  } catch (error) {
    console.error('Error fetching reporter home banner:', error);
    res.status(500).json({ error: 'Failed to fetch home banner' });
  }
}

async function uploadReporterHomeCardImage(req, res) {
  try {
    if (!req.file || !req.file.path) {
      return res.status(400).json({ error: 'No image uploaded' });
    }
    res.json({
      success: true,
      imageUrl: req.file.path,
      thumbnailUrl: req.file.thumbnailPath || req.file.path
    });
  } catch (error) {
    console.error('Error uploading reporter home card image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
}

// ==================== IN-APP POPUP NOTIFICATIONS ====================

function sanitizePopupPayload(body) {
  const errors = [];
  const title = String(body.title || '').trim();
  const message = String(body.message || '').trim();
  const language = normalizeNewsLanguage(body.language || '');

  if (!title) errors.push('Title is required');
  if (title.length > 120) errors.push('Title max 120 characters');
  if (!message) errors.push('Message is required');
  if (message.length > 1000) errors.push('Message max 1000 characters');
  if (!language) errors.push('Language is required');

  const priority = ['low', 'medium', 'high', 'critical'].includes(body.priority) ? body.priority : 'medium';
  const frequency = ['once', 'once_per_day', 'every_login', 'always'].includes(body.frequency) ? body.frequency : 'once';

  const startDate = new Date(body.startDate);
  const endDate = new Date(body.endDate);
  if (isNaN(startDate)) errors.push('Valid start date required');
  if (isNaN(endDate)) errors.push('Valid end date required');
  if (!isNaN(startDate) && !isNaN(endDate) && startDate > endDate) errors.push('End date must be after start date');

  let buttonUrl = String(body.buttonUrl || '').trim();
  if (buttonUrl && !/^https?:\/\//i.test(buttonUrl) && !buttonUrl.startsWith('/')) {
    errors.push('Button URL must start with http(s):// or /');
  }

  const audience = ['all', 'reporters', 'roles', 'states', 'districts'].includes(body.target?.audience)
    ? body.target.audience : 'all';
  const cleanList = (arr) => Array.isArray(arr) ? arr.map(v => String(v).trim()).filter(Boolean) : [];

  return {
    errors,
    data: {
      title,
      message,
      language,
      priority,
      frequency,
      startDate,
      endDate,
      isActive: body.isActive === true || body.isActive === 'true',
      buttonText: String(body.buttonText || '').trim().slice(0, 40),
      buttonUrl,
      imageUrl: String(body.imageUrl || '').trim(),
      target: {
        audience,
        reporterIds: audience === 'reporters' ? cleanList(body.target?.reporterIds) : [],
        roles: audience === 'roles' ? cleanList(body.target?.roles) : [],
        states: audience === 'states' ? cleanList(body.target?.states) : [],
        districts: audience === 'districts' ? cleanList(body.target?.districts) : []
      }
    }
  };
}

async function renderReporterPopupsPage(req, res) {
  try {
    const { getActiveLanguages } = require('../services/languageRegistry');
    res.render('reporter-popups', {
      title: 'In-App Popups',
      admin: req.admin,
      activePage: 'reporter-popups',
      languages: getActiveLanguages()
    });
  } catch (error) {
    console.error('Error rendering reporter popups page:', error);
    res.status(500).send('Error loading page');
  }
}

// Admin: list popups with view stats
async function getReporterPopupsAdmin(req, res) {
  try {
    const ReporterPopup = require('../models/ReporterPopup');
    const ReporterPopupView = require('../models/ReporterPopupView');

    const popups = await ReporterPopup.find().sort({ createdAt: -1 }).lean();
    const stats = await ReporterPopupView.aggregate([
      {
        $group: {
          _id: '$popupId',
          seen: { $sum: { $cond: [{ $gt: ['$viewCount', 0] }, 1, 0] } },
          dismissed: { $sum: { $cond: [{ $ne: ['$dismissedAt', null] }, 1, 0] } },
          clicked: { $sum: { $cond: [{ $ne: ['$clickedAt', null] }, 1, 0] } }
        }
      }
    ]);
    const statMap = {};
    stats.forEach(s => { statMap[String(s._id)] = s; });

    const now = new Date();
    res.json({
      popups: popups.map(p => {
        const st = statMap[String(p._id)] || { seen: 0, dismissed: 0, clicked: 0 };
        let status = 'inactive';
        if (p.isActive) {
          if (now < new Date(p.startDate)) status = 'scheduled';
          else if (now > new Date(p.endDate)) status = 'expired';
          else status = 'live';
        }
        return { ...p, stats: { seen: st.seen, dismissed: st.dismissed, clicked: st.clicked }, status };
      })
    });
  } catch (error) {
    console.error('Error listing popups:', error);
    res.status(500).json({ error: 'Failed to load popups' });
  }
}

async function createReporterPopup(req, res) {
  try {
    const { errors, data } = sanitizePopupPayload(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors[0] });

    const ReporterPopup = require('../models/ReporterPopup');
    data.createdBy = req.admin.id;
    data.createdByName = req.admin.username || req.admin.name || '';
    const popup = await ReporterPopup.create(data);

    try {
      const { logAudit } = require('../utils/auditLogger');
      logAudit({
        req,
        action: 'popup_create',
        entityType: 'ReporterPopup',
        entityId: popup._id.toString(),
        description: `Popup created: ${popup.title} (${popup.language})`,
        after: data
      });
    } catch (e) { /* audit optional */ }

    res.json({ success: true, popup });
  } catch (error) {
    console.error('Error creating popup:', error);
    res.status(500).json({ error: 'Failed to create popup' });
  }
}

async function updateReporterPopup(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid popup id' });

    const { errors, data } = sanitizePopupPayload(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors[0] });

    const ReporterPopup = require('../models/ReporterPopup');
    const before = await ReporterPopup.findById(id).lean();
    if (!before) return res.status(404).json({ error: 'Popup not found' });

    const popup = await ReporterPopup.findByIdAndUpdate(id, { $set: data }, { new: true });

    try {
      const { logAudit } = require('../utils/auditLogger');
      logAudit({
        req,
        action: 'popup_update',
        entityType: 'ReporterPopup',
        entityId: id,
        description: `Popup updated: ${data.title}`,
        before,
        after: data
      });
    } catch (e) { /* audit optional */ }

    res.json({ success: true, popup });
  } catch (error) {
    console.error('Error updating popup:', error);
    res.status(500).json({ error: 'Failed to update popup' });
  }
}

async function deleteReporterPopup(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid popup id' });

    const ReporterPopup = require('../models/ReporterPopup');
    const ReporterPopupView = require('../models/ReporterPopupView');
    const popup = await ReporterPopup.findByIdAndDelete(id);
    if (!popup) return res.status(404).json({ error: 'Popup not found' });
    await ReporterPopupView.deleteMany({ popupId: id });

    try {
      const { logAudit } = require('../utils/auditLogger');
      logAudit({
        req,
        action: 'popup_delete',
        entityType: 'ReporterPopup',
        entityId: id,
        description: `Popup deleted: ${popup.title}`,
        before: popup.toObject()
      });
    } catch (e) { /* audit optional */ }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting popup:', error);
    res.status(500).json({ error: 'Failed to delete popup' });
  }
}

// Admin: per-popup view history
async function getReporterPopupHistory(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid popup id' });

    const ReporterPopupView = require('../models/ReporterPopupView');
    const views = await ReporterPopupView.find({ popupId: id })
      .populate('reporterId', 'name username role location')
      .sort({ lastSeenAt: -1 })
      .limit(500)
      .lean();

    res.json({
      history: views.map(v => ({
        reporter: v.reporterId ? {
          name: v.reporterId.name || v.reporterId.username,
          role: v.reporterId.role,
          location: v.reporterId.location
        } : null,
        viewCount: v.viewCount,
        firstSeenAt: v.firstSeenAt,
        lastSeenAt: v.lastSeenAt,
        dismissedAt: v.dismissedAt,
        clickedAt: v.clickedAt
      }))
    });
  } catch (error) {
    console.error('Error loading popup history:', error);
    res.status(500).json({ error: 'Failed to load history' });
  }
}

/** Reporter target match check — anni server-side, DB doc base */
function popupTargetsReporter(popup, reporter) {
  const t = popup.target || {};
  const audience = t.audience || 'all';
  if (audience === 'all') return true;
  if (audience === 'reporters') return (t.reporterIds || []).includes(String(reporter._id));
  if (audience === 'roles') return (t.roles || []).includes(reporter.role);
  if (audience === 'states') {
    const myStates = [
      ...(reporter.assignedStates || []),
      ...(reporter.assignedLocations || []),
      reporter.assignedState,
      reporter.location
    ].filter(Boolean);
    return (t.states || []).some(s => myStates.includes(s));
  }
  if (audience === 'districts') {
    const myDistricts = [
      ...(reporter.assignedDistricts || []),
      ...(reporter.assignedLocations || []),
      reporter.location
    ].filter(Boolean);
    return (t.districts || []).some(d => myDistricts.includes(d));
  }
  return false;
}

// Admin: dropdown data for popup targeting (reporters, states, districts)
async function getReporterPopupTargetOptions(req, res) {
  try {
    const Location = require('../models/Location');
    const [reporters, states, districts] = await Promise.all([
      Admin.find({ role: { $in: ['editor', 'subeditor'] } })
        .select('name username role workingLanguage')
        .sort({ name: 1 })
        .lean(),
      Location.find({ isActive: true, locationType: 'state' }).select('name').sort({ name: 1 }).lean(),
      Location.find({ isActive: true, locationType: 'district' }).select('name parentName').sort({ name: 1 }).lean()
    ]);

    res.json({
      reporters: reporters.map(r => ({
        id: String(r._id),
        name: r.name || r.username,
        role: r.role,
        language: r.workingLanguage || 'te'
      })),
      states: states.map(s => s.name),
      districts: districts.map(d => ({ name: d.name, state: d.parentName || '' }))
    });
  } catch (error) {
    console.error('Error loading popup target options:', error);
    res.status(500).json({ error: 'Failed to load options' });
  }
}

// Reporter: active popups (language + schedule + target + frequency filtered)
async function getActiveReporterPopups(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const reporter = await Admin.findById(reporterId)
      .select('role workingLanguage assignedStates assignedState assignedDistricts location')
      .lean();
    if (!reporter) return res.status(404).json({ error: 'Account not found' });

    const lang = normalizeNewsLanguage(reporter.workingLanguage || 'te') || 'te';
    const now = new Date();

    const ReporterPopup = require('../models/ReporterPopup');
    const ReporterPopupView = require('../models/ReporterPopupView');

    // Indexed query: active + exact language + schedule window
    const popups = await ReporterPopup.find({
      isActive: true,
      language: lang,
      startDate: { $lte: now },
      endDate: { $gte: now }
    }).sort({ createdAt: -1 }).limit(20).lean();

    if (!popups.length) return res.json({ popups: [] });

    const targeted = popups.filter(p => popupTargetsReporter(p, reporter));
    if (!targeted.length) return res.json({ popups: [] });

    // View states okka query lo
    const views = await ReporterPopupView.find({
      reporterId,
      popupId: { $in: targeted.map(p => p._id) }
    }).lean();
    const viewMap = {};
    views.forEach(v => { viewMap[String(v.popupId)] = v; });

    // IST day start (once_per_day check ki)
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
    const dayStart = new Date(`${ymd}T00:00:00.000+05:30`);

    const eligible = targeted.filter(p => {
      const v = viewMap[String(p._id)];
      if (!v || !v.dismissedAt) return true; // inka dismiss cheyaledu
      switch (p.frequency) {
        case 'once': return false;
        case 'once_per_day': return new Date(v.dismissedAt) < dayStart;
        case 'every_login': return true;  // client sessionStorage handles per-session
        case 'always': return true;
        default: return false;
      }
    });

    // Priority order: critical mundu
    const prioRank = { critical: 0, high: 1, medium: 2, low: 3 };
    eligible.sort((a, b) => (prioRank[a.priority] ?? 9) - (prioRank[b.priority] ?? 9));

    res.json({
      popups: eligible.map(p => ({
        id: String(p._id),
        title: p.title,
        message: p.message,
        priority: p.priority,
        frequency: p.frequency,
        buttonText: p.buttonText || '',
        buttonUrl: p.buttonUrl || '',
        imageUrl: p.imageUrl || ''
      }))
    });
  } catch (error) {
    console.error('Error fetching active popups:', error);
    res.status(500).json({ error: 'Failed to fetch popups' });
  }
}

// Reporter: popup event ack (seen / dismissed / clicked)
async function ackReporterPopup(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const { id } = req.params;
    const event = String((req.body || {}).event || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'Invalid popup id' });
    if (!['seen', 'dismissed', 'clicked'].includes(event)) {
      return res.status(400).json({ error: 'Invalid event' });
    }

    const ReporterPopup = require('../models/ReporterPopup');
    const popup = await ReporterPopup.findById(id).select('_id').lean();
    if (!popup) return res.status(404).json({ error: 'Popup not found' });

    const ReporterPopupView = require('../models/ReporterPopupView');
    const now = new Date();
    const update = { $set: { lastSeenAt: now }, $setOnInsert: { firstSeenAt: now } };
    if (event === 'seen') update.$inc = { viewCount: 1 };
    if (event === 'dismissed') update.$set.dismissedAt = now;
    if (event === 'clicked') update.$set.clickedAt = now;

    await ReporterPopupView.updateOne(
      { popupId: id, reporterId },
      update,
      { upsert: true }
    );

    res.json({ success: true });
  } catch (error) {
    // Upsert race (duplicate key) ni ignore cheyochu — record already undi
    if (error && error.code === 11000) return res.json({ success: true });
    console.error('Error acking popup:', error);
    res.status(500).json({ error: 'Failed to record event' });
  }
}

function defaultGuidelinesForLang(code) {
  const lang = String(code || 'en').toLowerCase();
  const packs = {
    te: {
      pageTitle: 'రిపోర్టర్ గైడ్‌లైన్స్',
      footerText: 'ఈ నియమాలు ఉల్లంఘిస్తే ఖాతా సస్పెండ్ కావచ్చు.',
      cards: [
        {
          id: 'intro',
          type: 'intro',
          title: 'Tehelka News కి స్వాగతం',
          body: 'మీరు verified reporter. నిజమైన వార్తలు అందించడం మీ పాత్ర. త్వరగా publish కావాలంటే ఈ guidelines follow చేయండి.',
          items: [],
          backgroundColor: '#FFFFFF',
          titleColor: '#111827',
          bodyColor: '#4B5563',
          accentColor: '#2563EB',
          borderColor: '#F3F4F6',
          titleFontSize: 15,
          bodyFontSize: 13,
          titleUnderline: false,
          titleBold: true,
          borderRadius: 16,
          showIcon: true,
          iconBgColor: '#EFF6FF',
          iconColor: '#2563EB'
        },
        {
          id: 'dos',
          type: 'list',
          title: 'ఏమి పోస్ట్ చేయాలి',
          body: '',
          items: [
            { text: 'మీ ప్రాంతం local news.', underline: false, bold: false, color: '' },
            { text: 'Submit చేసే ముందు facts verify చేయండి.', underline: false, bold: false, color: '' },
            { text: 'News కి సంబంధించిన good quality images.', underline: false, bold: false, color: '' },
            { text: 'Clear, short headlines రాయండి.', underline: false, bold: false, color: '' }
          ],
          backgroundColor: '#FFFFFF',
          titleColor: '#111827',
          bodyColor: '#4B5563',
          accentColor: '#16A34A',
          borderColor: '#F3F4F6',
          titleFontSize: 15,
          bodyFontSize: 13,
          titleUnderline: false,
          titleBold: true,
          borderRadius: 16,
          showIcon: true,
          iconBgColor: '#F0FDF4',
          iconColor: '#16A34A'
        },
        {
          id: 'donts',
          type: 'list',
          title: 'నిషేధిత కంటెంట్',
          body: '',
          items: [
            { text: 'Fake news / unverified rumors.', underline: false, bold: false, color: '' },
            { text: 'Hate speech, violence, explicit content.', underline: false, bold: false, color: '' },
            { text: 'Personal opinions / biased journalism.', underline: false, bold: false, color: '' },
            { text: 'Permission లేని copyrighted images.', underline: false, bold: false, color: '' }
          ],
          backgroundColor: '#FFFFFF',
          titleColor: '#111827',
          bodyColor: '#4B5563',
          accentColor: '#E31E24',
          borderColor: '#F3F4F6',
          titleFontSize: 15,
          bodyFontSize: 13,
          titleUnderline: false,
          titleBold: true,
          borderRadius: 16,
          showIcon: true,
          iconBgColor: '#FEF2F2',
          iconColor: '#E31E24'
        }
      ]
    },
    hi: {
      pageTitle: 'रिपोर्टर गाइडलाइंस',
      footerText: 'इन नियमों का उल्लंघन करने पर खाता सस्पेंड हो सकता है।',
      cards: [
        {
          id: 'intro',
          type: 'intro',
          title: 'Tehelka News में आपका स्वागत है',
          body: 'आप एक verified reporter हैं। असली खबरें पहुंचाना आपकी भूमिका है। जल्दी publish के लिए ये guidelines फॉलो करें।',
          items: [],
          backgroundColor: '#FFFFFF',
          titleColor: '#111827',
          bodyColor: '#4B5563',
          accentColor: '#2563EB',
          borderColor: '#F3F4F6',
          titleFontSize: 15,
          bodyFontSize: 13,
          titleUnderline: false,
          titleBold: true,
          borderRadius: 16,
          showIcon: true,
          iconBgColor: '#EFF6FF',
          iconColor: '#2563EB'
        },
        {
          id: 'dos',
          type: 'list',
          title: 'क्या पोस्ट करें',
          body: '',
          items: [
            { text: 'अपने क्षेत्र की लोकल न्यूज़।', underline: false, bold: false, color: '' },
            { text: 'सबमिट से पहले फैक्ट्स वेरिफाई करें।', underline: false, bold: false, color: '' },
            { text: 'न्यूज़ से जुड़ी अच्छी क्वालिटी इमेज।', underline: false, bold: false, color: '' },
            { text: 'क्लियर, शॉर्ट हेडलाइन लिखें।', underline: false, bold: false, color: '' }
          ],
          backgroundColor: '#FFFFFF',
          titleColor: '#111827',
          bodyColor: '#4B5563',
          accentColor: '#16A34A',
          borderColor: '#F3F4F6',
          titleFontSize: 15,
          bodyFontSize: 13,
          titleUnderline: false,
          titleBold: true,
          borderRadius: 16,
          showIcon: true,
          iconBgColor: '#F0FDF4',
          iconColor: '#16A34A'
        },
        {
          id: 'donts',
          type: 'list',
          title: 'प्रतिबंधित कंटेंट',
          body: '',
          items: [
            { text: 'फेक न्यूज़ / अनवेरिफाइड अफवाहें।', underline: false, bold: false, color: '' },
            { text: 'हेट स्पीच, हिंसा, explicit कंटेंट।', underline: false, bold: false, color: '' },
            { text: 'पर्सनल ओपिनियन / बायस्ड जर्नलिज़्म।', underline: false, bold: false, color: '' },
            { text: 'बिना अनुमति copyrighted इमेज।', underline: false, bold: false, color: '' }
          ],
          backgroundColor: '#FFFFFF',
          titleColor: '#111827',
          bodyColor: '#4B5563',
          accentColor: '#E31E24',
          borderColor: '#F3F4F6',
          titleFontSize: 15,
          bodyFontSize: 13,
          titleUnderline: false,
          titleBold: true,
          borderRadius: 16,
          showIcon: true,
          iconBgColor: '#FEF2F2',
          iconColor: '#E31E24'
        }
      ]
    },
    en: {
      pageTitle: 'Reporter Guidelines',
      footerText: 'Violating these rules may result in account suspension.',
      cards: [
        {
          id: 'intro',
          type: 'intro',
          title: 'Welcome to Tehelka News',
          body: 'As a verified reporter, you play a crucial role in bringing authentic news to our readers. Please follow these guidelines to ensure your news gets published quickly.',
          items: [],
          backgroundColor: '#FFFFFF',
          titleColor: '#111827',
          bodyColor: '#4B5563',
          accentColor: '#2563EB',
          borderColor: '#F3F4F6',
          titleFontSize: 15,
          bodyFontSize: 13,
          titleUnderline: false,
          titleBold: true,
          borderRadius: 16,
          showIcon: true,
          iconBgColor: '#EFF6FF',
          iconColor: '#2563EB'
        },
        {
          id: 'dos',
          type: 'list',
          title: 'What to Post',
          body: '',
          items: [
            { text: 'Local news and happenings in your area.', underline: false, bold: false, color: '' },
            { text: 'Verify the facts before submitting the news.', underline: false, bold: false, color: '' },
            { text: 'Use high-quality images related to the news.', underline: false, bold: false, color: '' },
            { text: 'Write clear, short, and engaging headlines.', underline: false, bold: false, color: '' }
          ],
          backgroundColor: '#FFFFFF',
          titleColor: '#111827',
          bodyColor: '#4B5563',
          accentColor: '#16A34A',
          borderColor: '#F3F4F6',
          titleFontSize: 15,
          bodyFontSize: 13,
          titleUnderline: false,
          titleBold: true,
          borderRadius: 16,
          showIcon: true,
          iconBgColor: '#F0FDF4',
          iconColor: '#16A34A'
        },
        {
          id: 'donts',
          type: 'list',
          title: 'Prohibited Content',
          body: '',
          items: [
            { text: 'Fake news or unverified rumors.', underline: false, bold: false, color: '' },
            { text: 'Hate speech, violence, or explicit content.', underline: false, bold: false, color: '' },
            { text: 'Personal opinions or biased journalism.', underline: false, bold: false, color: '' },
            { text: 'Copyrighted images without permission.', underline: false, bold: false, color: '' }
          ],
          backgroundColor: '#FFFFFF',
          titleColor: '#111827',
          bodyColor: '#4B5563',
          accentColor: '#E31E24',
          borderColor: '#F3F4F6',
          titleFontSize: 15,
          bodyFontSize: 13,
          titleUnderline: false,
          titleBold: true,
          borderRadius: 16,
          showIcon: true,
          iconBgColor: '#FEF2F2',
          iconColor: '#E31E24'
        }
      ]
    }
  };

  const base = packs[lang] || packs.en;
  return {
    language: lang,
    pageTitle: base.pageTitle,
    pageTitleColor: '#111827',
    pageTitleFontSize: 17,
    pageTitleUnderline: false,
    pageBgColor: '#F8F9FA',
    footerText: base.footerText,
    footerColor: '#9CA3AF',
    footerFontSize: 12,
    cards: base.cards
  };
}

function normalizeGuidelineItem(item) {
  const src = item && typeof item === 'object' ? item : {};
  return {
    text: String(src.text || '').trim(),
    underline: !!src.underline,
    bold: !!src.bold,
    color: String(src.color || '').trim()
  };
}

function normalizeGuidelineCard(card, index) {
  const src = card && typeof card === 'object' ? card : {};
  const id = String(src.id || `card-${index + 1}`).trim();
  return {
    id,
    type: ['intro', 'list', 'text', 'note'].includes(src.type) ? src.type : 'text',
    title: String(src.title || '').trim(),
    body: String(src.body || '').trim(),
    items: Array.isArray(src.items) ? src.items.map(normalizeGuidelineItem).filter((i) => i.text) : [],
    backgroundColor: String(src.backgroundColor || '#FFFFFF').trim(),
    titleColor: String(src.titleColor || '#111827').trim(),
    bodyColor: String(src.bodyColor || '#4B5563').trim(),
    accentColor: String(src.accentColor || '#E31E24').trim(),
    borderColor: String(src.borderColor || '#F3F4F6').trim(),
    titleFontSize: Math.min(32, Math.max(12, Number(src.titleFontSize) || 15)),
    bodyFontSize: Math.min(24, Math.max(11, Number(src.bodyFontSize) || 13)),
    titleUnderline: !!src.titleUnderline,
    titleBold: src.titleBold !== false,
    borderRadius: Math.min(32, Math.max(0, Number(src.borderRadius) || 16)),
    showIcon: src.showIcon !== false,
    iconBgColor: String(src.iconBgColor || '#FEF2F2').trim(),
    iconColor: String(src.iconColor || '#E31E24').trim()
  };
}

function mergeGuidelinesDoc(doc, language) {
  const fallback = defaultGuidelinesForLang(language);
  if (!doc) return fallback;
  return {
    language: doc.language || language,
    pageTitle: doc.pageTitle || fallback.pageTitle,
    pageTitleColor: doc.pageTitleColor || fallback.pageTitleColor,
    pageTitleFontSize: Number(doc.pageTitleFontSize) || fallback.pageTitleFontSize,
    pageTitleUnderline: !!doc.pageTitleUnderline,
    pageBgColor: doc.pageBgColor || fallback.pageBgColor,
    footerText: doc.footerText != null ? doc.footerText : fallback.footerText,
    footerColor: doc.footerColor || fallback.footerColor,
    footerFontSize: Number(doc.footerFontSize) || fallback.footerFontSize,
    cards: Array.isArray(doc.cards)
      ? doc.cards.map(normalizeGuidelineCard)
      : fallback.cards
  };
}

async function renderReporterGuidelinesPage(req, res) {
  try {
    const { getActiveLanguages } = require('../services/languageRegistry');
    res.render('reporter-guidelines', {
      title: 'Reporter Guidelines',
      admin: req.admin,
      activePage: 'reporter-guidelines',
      languages: getActiveLanguages()
    });
  } catch (error) {
    console.error('Error rendering reporter guidelines page:', error);
    res.status(500).send('Error loading page');
  }
}

async function getReporterGuidelinesAdmin(req, res) {
  try {
    const { getActiveLanguages } = require('../services/languageRegistry');
    const ReporterGuidelines = require('../models/ReporterGuidelines');
    const languages = getActiveLanguages();
    const docs = await ReporterGuidelines.find({}).lean();
    const byLang = {};
    docs.forEach((d) => {
      byLang[d.language] = d;
    });

    const items = languages.map((lang) => {
      const merged = mergeGuidelinesDoc(byLang[lang.code], lang.code);
      return {
        ...merged,
        name: lang.name,
        nativeName: lang.nativeName,
        isSaved: !!byLang[lang.code]
      };
    });

    res.json({ items });
  } catch (error) {
    console.error('Error fetching reporter guidelines:', error);
    res.status(500).json({ error: 'Failed to fetch guidelines' });
  }
}

async function updateReporterGuidelinesAdmin(req, res) {
  try {
    const body = req.body || {};
    const code = String(body.language || '')
      .trim()
      .toLowerCase();
    if (!code) return res.status(400).json({ error: 'Language is required' });

    const { getActiveLanguages } = require('../services/languageRegistry');
    const active = getActiveLanguages().some((l) => l.code === code);
    if (!active) {
      return res.status(400).json({ error: 'Language is not active in admin languages' });
    }

    const payload = mergeGuidelinesDoc(
      {
        language: code,
        pageTitle: body.pageTitle,
        pageTitleColor: body.pageTitleColor,
        pageTitleFontSize: body.pageTitleFontSize,
        pageTitleUnderline: body.pageTitleUnderline,
        pageBgColor: body.pageBgColor,
        footerText: body.footerText,
        footerColor: body.footerColor,
        footerFontSize: body.footerFontSize,
        cards: body.cards
      },
      code
    );

    const ReporterGuidelines = require('../models/ReporterGuidelines');
    const doc = await ReporterGuidelines.findOneAndUpdate(
      { language: code },
      { ...payload, language: code },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      success: true,
      item: mergeGuidelinesDoc(doc.toObject ? doc.toObject() : doc, code)
    });
  } catch (error) {
    console.error('Error updating reporter guidelines:', error);
    res.status(500).json({ error: 'Failed to save guidelines' });
  }
}

async function getReporterGuidelines(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const admin = await Admin.findById(reporterId).select('workingLanguage').lean();
    let lang = String(admin?.workingLanguage || req.query.language || 'te')
      .trim()
      .toLowerCase();
    if (!lang) lang = 'te';

    const ReporterGuidelines = require('../models/ReporterGuidelines');
    let doc = await ReporterGuidelines.findOne({ language: lang }).lean();
    if (!doc && lang !== 'en') {
      doc = await ReporterGuidelines.findOne({ language: 'en' }).lean();
    }
    if (!doc && lang !== 'te') {
      doc = await ReporterGuidelines.findOne({ language: 'te' }).lean();
    }

    res.json(mergeGuidelinesDoc(doc, lang));
  } catch (error) {
    console.error('Error fetching reporter guidelines:', error);
    res.status(500).json({ error: 'Failed to fetch guidelines' });
  }
}

function defaultEarningForLang(code) {
  const lang = String(code || 'te').toLowerCase();
  const packs = {
    te: {
      greetingTitle: 'ప్రియమైన రిపోర్టర్ మిత్రులారా,',
      greetingBody:
        'మీ స్థానిక కనెక్షన్లు, గ్రౌండ్ లెవల్ సమాచారం ద్వారా అదనపు ఆదాయం సంపాదించవచ్చు. క్రింది వివరాలు పంపండి — మా సేల్స్ టీమ్ ఫాలో అప్ చేసి యాడ్ సేల్ చేస్తుంది.',
      highlightText:
        'మీరు ఇచ్చిన సమాచారం ద్వారా సేల్స్ టీమ్ అడ్వర్టైజ్‌మెంట్ సేల్ చేస్తే, ఆ సేల్‌పై మీకు 10% కమీషన్ లభిస్తుంది.',
      infoTitle: 'మీరు పంపాల్సిన సమాచారం',
      infoIntro: 'క్రింది రకాల సమాచారం పంపండి:',
      infoItems: [
        'కొత్తగా షాపులు ప్రారంభం',
        'కొత్తగా రెస్టారెంట్ / హోటళ్లు ప్రారంభం',
        'కొత్తగా షోరూమ్‌లు / బ్రాండ్ స్టోర్లు ప్రారంభం',
        'హాస్పిటల్ / క్లినిక్ ప్రారంభం',
        'స్కూల్ / కాలేజ్ / కోచింగ్ సెంటర్ ప్రారంభం',
        'లోకల్ ప్రముఖ వ్యక్తుల వార్తలు',
        'మరణ వార్తలు (Obituary ads కోసం ఉపయోగపడతాయి)'
      ],
      incomeTitle: 'మీ ఆదాయం ఎలా ఉంటుంది?',
      incomeBody:
        'యాడ్ సేల్ అయిన మొత్తంపై 10% కమీషన్. ప్రతి నెల 10వ తేదీన మీ అకౌంట్‌కు జమ అవుతుంది.\n\nమీ లోకల్ ఇన్ఫ్లుయెన్స్‌ను ఆదాయంగా మార్చుకోండి — ఇప్పుడే సమాచారం పంపండి.',
      signoffText: 'మీ Tehelka News',
      ctaText: 'అదనపు ఆదాయం పొందడానికి'
    },
    hi: {
      greetingTitle: 'प्रिय रिपोर्टर मित्रों,',
      greetingBody:
        'अपने लोकल कनेक्शन और ग्राउंड-लेवल जानकारी से अतिरिक्त आय कमा सकते हैं। नीचे दिए विवरण भेजें — हमारी सेल्स टीम फॉलो-अप कर विज्ञापन सेल करेगी।',
      highlightText:
        'आपकी जानकारी से सेल्स टीम विज्ञापन सेल करे तो उस सेल पर आपको 10% कमीशन मिलेगा।',
      infoTitle: 'आपको भेजनी वाली जानकारी',
      infoIntro: 'इन प्रकार की जानकारी भेजें:',
      infoItems: [
        'नई दुकानें खुलना',
        'नए रेस्तरां / होटल खुलना',
        'नए शोरूम / ब्रांड स्टोर',
        'अस्पताल / क्लिनिक खुलना',
        'स्कूल / कॉलेज / कोचिंग सेंटर',
        'लोकल प्रमुख व्यक्तियों की खबरें',
        'मृत्यु समाचार (Obituary ads के लिए)'
      ],
      incomeTitle: 'आपकी आय कैसे होगी?',
      incomeBody:
        'ऐड सेल राशि पर 10% कमीशन। हर महीने की 10 तारीख को आपके अकाउंट में जमा।\n\nअपना लोकल प्रभाव आय में बदलें — अभी जानकारी भेजें।',
      signoffText: 'आपका Tehelka News',
      ctaText: 'अतिरिक्त आय पाने के लिए'
    },
    en: {
      greetingTitle: 'Dear reporter friends,',
      greetingBody:
        'Use your local connections and ground-level information to earn extra income. Send the details below — our sales team will follow up and close the ad sale.',
      highlightText:
        'If our sales team closes an advertisement sale from your information, you get 10% commission on that sale.',
      infoTitle: 'Information you should send',
      infoIntro: 'Send these types of information:',
      infoItems: [
        'New shop openings',
        'New restaurant / hotel launches',
        'New showrooms / brand stores',
        'Hospital / clinic openings',
        'School / college / coaching center openings',
        'Local prominent personality news',
        'Obituary news (useful for obituary ads)'
      ],
      incomeTitle: 'How will your income work?',
      incomeBody:
        '10% commission on the ad sale amount. Credited to your account on the 10th of every month.\n\nTurn your local influence into income — send information now.',
      signoffText: 'Yours, Tehelka News',
      ctaText: 'To earn additional income'
    }
  };

  const t = packs[lang] || packs.en;
  return {
    language: lang,
    pageBgColor: '#F3F4F6',
    heroImageUrl: '',
    greetingTitle: t.greetingTitle,
    greetingTitleColor: '#111827',
    greetingTitleFontSize: 18,
    greetingTitleBold: true,
    greetingTitleUnderline: false,
    greetingBody: t.greetingBody,
    greetingBodyColor: '#374151',
    greetingBodyFontSize: 14,
    highlightText: t.highlightText,
    highlightBgColor: '#FFFFFF',
    highlightTextColor: '#111827',
    highlightBorderColor: '#111827',
    highlightFontSize: 14,
    highlightBold: false,
    infoTitle: t.infoTitle,
    infoTitleColor: '#111827',
    infoTitleFontSize: 17,
    infoTitleBold: true,
    infoTitleUnderline: false,
    infoIntro: t.infoIntro,
    infoIntroColor: '#374151',
    infoIntroFontSize: 14,
    infoItems: t.infoItems,
    infoItemColor: '#1F2937',
    infoItemFontSize: 14,
    infoBulletColor: '#111827',
    incomeTitle: t.incomeTitle,
    incomeTitleColor: '#111827',
    incomeTitleFontSize: 17,
    incomeTitleBold: true,
    incomeTitleUnderline: false,
    incomeBody: t.incomeBody,
    incomeBodyColor: '#374151',
    incomeBodyFontSize: 14,
    signoffText: t.signoffText,
    signoffColor: '#111827',
    signoffFontSize: 15,
    signoffBold: true,
    ctaText: t.ctaText,
    ctaUrl: 'https://wa.me/',
    ctaBgColor: '#16A34A',
    ctaTextColor: '#FFFFFF',
    ctaFontSize: 15,
    ctaBold: true,
    ctaEnabled: true
  };
}

function mergeEarningDoc(doc, language) {
  const fallback = defaultEarningForLang(language);
  if (!doc) return fallback;
  const pick = (key, cast) => {
    if (doc[key] === undefined || doc[key] === null) return fallback[key];
    return cast ? cast(doc[key]) : doc[key];
  };
  return {
    language: doc.language || language,
    pageBgColor: pick('pageBgColor'),
    heroImageUrl: pick('heroImageUrl'),
    greetingTitle: pick('greetingTitle'),
    greetingTitleColor: pick('greetingTitleColor'),
    greetingTitleFontSize: Number(pick('greetingTitleFontSize')) || fallback.greetingTitleFontSize,
    greetingTitleBold: doc.greetingTitleBold !== undefined ? !!doc.greetingTitleBold : fallback.greetingTitleBold,
    greetingTitleUnderline: !!doc.greetingTitleUnderline,
    greetingBody: pick('greetingBody'),
    greetingBodyColor: pick('greetingBodyColor'),
    greetingBodyFontSize: Number(pick('greetingBodyFontSize')) || fallback.greetingBodyFontSize,
    highlightText: pick('highlightText'),
    highlightBgColor: pick('highlightBgColor'),
    highlightTextColor: pick('highlightTextColor'),
    highlightBorderColor: pick('highlightBorderColor'),
    highlightFontSize: Number(pick('highlightFontSize')) || fallback.highlightFontSize,
    highlightBold: !!doc.highlightBold,
    infoTitle: pick('infoTitle'),
    infoTitleColor: pick('infoTitleColor'),
    infoTitleFontSize: Number(pick('infoTitleFontSize')) || fallback.infoTitleFontSize,
    infoTitleBold: doc.infoTitleBold !== undefined ? !!doc.infoTitleBold : fallback.infoTitleBold,
    infoTitleUnderline: !!doc.infoTitleUnderline,
    infoIntro: pick('infoIntro'),
    infoIntroColor: pick('infoIntroColor'),
    infoIntroFontSize: Number(pick('infoIntroFontSize')) || fallback.infoIntroFontSize,
    infoItems: Array.isArray(doc.infoItems)
      ? doc.infoItems.map((x) => String(x || '').trim()).filter(Boolean)
      : fallback.infoItems,
    infoItemColor: pick('infoItemColor'),
    infoItemFontSize: Number(pick('infoItemFontSize')) || fallback.infoItemFontSize,
    infoBulletColor: pick('infoBulletColor'),
    incomeTitle: pick('incomeTitle'),
    incomeTitleColor: pick('incomeTitleColor'),
    incomeTitleFontSize: Number(pick('incomeTitleFontSize')) || fallback.incomeTitleFontSize,
    incomeTitleBold: doc.incomeTitleBold !== undefined ? !!doc.incomeTitleBold : fallback.incomeTitleBold,
    incomeTitleUnderline: !!doc.incomeTitleUnderline,
    incomeBody: pick('incomeBody'),
    incomeBodyColor: pick('incomeBodyColor'),
    incomeBodyFontSize: Number(pick('incomeBodyFontSize')) || fallback.incomeBodyFontSize,
    signoffText: pick('signoffText'),
    signoffColor: pick('signoffColor'),
    signoffFontSize: Number(pick('signoffFontSize')) || fallback.signoffFontSize,
    signoffBold: doc.signoffBold !== undefined ? !!doc.signoffBold : fallback.signoffBold,
    ctaText: pick('ctaText'),
    ctaUrl: pick('ctaUrl'),
    ctaBgColor: pick('ctaBgColor'),
    ctaTextColor: pick('ctaTextColor'),
    ctaFontSize: Number(pick('ctaFontSize')) || fallback.ctaFontSize,
    ctaBold: doc.ctaBold !== undefined ? !!doc.ctaBold : fallback.ctaBold,
    ctaEnabled: doc.ctaEnabled !== undefined ? !!doc.ctaEnabled : fallback.ctaEnabled
  };
}

async function renderReporterEarningPage(req, res) {
  try {
    const { getActiveLanguages } = require('../services/languageRegistry');
    res.render('reporter-earning', {
      title: 'Reporter Earning Page',
      admin: req.admin,
      activePage: 'reporter-earning',
      languages: getActiveLanguages()
    });
  } catch (error) {
    console.error('Error rendering reporter earning page:', error);
    res.status(500).send('Error loading page');
  }
}

async function getReporterEarningAdmin(req, res) {
  try {
    const { getActiveLanguages } = require('../services/languageRegistry');
    const ReporterEarning = require('../models/ReporterEarning');
    const languages = getActiveLanguages();
    const docs = await ReporterEarning.find({}).lean();
    const byLang = {};
    docs.forEach((d) => {
      byLang[d.language] = d;
    });
    const items = languages.map((lang) => ({
      ...mergeEarningDoc(byLang[lang.code], lang.code),
      name: lang.name,
      nativeName: lang.nativeName,
      isSaved: !!byLang[lang.code]
    }));
    res.json({ items });
  } catch (error) {
    console.error('Error fetching reporter earning:', error);
    res.status(500).json({ error: 'Failed to fetch earning page' });
  }
}

async function updateReporterEarningAdmin(req, res) {
  try {
    const body = req.body || {};
    const code = String(body.language || '')
      .trim()
      .toLowerCase();
    if (!code) return res.status(400).json({ error: 'Language is required' });

    const { getActiveLanguages } = require('../services/languageRegistry');
    if (!getActiveLanguages().some((l) => l.code === code)) {
      return res.status(400).json({ error: 'Language is not active' });
    }

    const payload = mergeEarningDoc({ ...body, language: code }, code);
    const ReporterEarning = require('../models/ReporterEarning');
    const doc = await ReporterEarning.findOneAndUpdate(
      { language: code },
      { ...payload, language: code },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      success: true,
      item: mergeEarningDoc(doc.toObject ? doc.toObject() : doc, code)
    });
  } catch (error) {
    console.error('Error updating reporter earning:', error);
    res.status(500).json({ error: 'Failed to save earning page' });
  }
}

async function getReporterEarning(req, res) {
  try {
    const reporterId = resolveReporterId(req);
    if (!reporterId) return res.status(401).json({ error: 'Unauthorized' });

    const admin = await Admin.findById(reporterId).select('workingLanguage').lean();
    let lang = String(admin?.workingLanguage || req.query.language || 'te')
      .trim()
      .toLowerCase();
    if (!lang) lang = 'te';

    const ReporterEarning = require('../models/ReporterEarning');
    let doc = await ReporterEarning.findOne({ language: lang }).lean();
    if (!doc && lang !== 'en') doc = await ReporterEarning.findOne({ language: 'en' }).lean();
    if (!doc && lang !== 'te') doc = await ReporterEarning.findOne({ language: 'te' }).lean();

    res.json(mergeEarningDoc(doc, lang));
  } catch (error) {
    console.error('Error fetching reporter earning:', error);
    res.status(500).json({ error: 'Failed to fetch earning page' });
  }
}

async function uploadReporterEarningImage(req, res) {
  try {
    if (!req.file || !req.file.path) {
      return res.status(400).json({ error: 'No image uploaded' });
    }
    res.json({
      success: true,
      imageUrl: req.file.path,
      thumbnailUrl: req.file.thumbnailPath || req.file.path
    });
  } catch (error) {
    console.error('Error uploading earning image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
}

module.exports = {
  deleteUserById,
  renderLoginPage,
  login,
  logout,
  requireAuth,
  requireSidebarMenu,
  requireAdmin,
  requireSuperAdmin,
  requireEditor,
  renderDashboard,
  getScopedAnalytics,
  renderProfilePage,
  updateProfile,
  renderRegisterEditorPage,
  registerEditor,
  renderEditorsPage,
  renderPerformanceAnalyticsPage,
  updateEditor,
  toggleEditorStatus,
  changeEditorPassword,
  deleteEditor,
  renderImpersonatedDashboard,
  renderImpersonatedNewsList,
  getImpersonatedNewsCount,
  getMultiEditorReportData,
  renderUsersListPage,
  getUserById,
  renderReportsPage,
  renderNotificationsPage,
  sendNotification,
  getNotificationHistory,
  getNotificationStats,
  getRecentNotifications,
  getNotificationById,
  deleteNotification,
  deleteAllNotifications,
  markNotificationOpened,
  markNotificationReceived,
  renderOneSignalAnalyticsPage,
  getOneSignalAnalytics,
  updateProfileImage,
  renderR2UsagePage,
  reporterLogin,
  getReporterProfile,
  renderPendingNewsPage,
  getPendingNewsDuplicateCheck,
  getPendingNewsDuplicateMatches,
  updatePendingNews,
  approveNews,
  rejectNews,
  sendBackForEdit,
  getNewsRevisionDiff,
  checkDuplicateArticles,
  getDuplicateReferenceArticle,
  translateForDuplicateReview,
  renderPlagiarismReportPage,
  getDuplicateDetails,
  renderRejectedNewsPage,
  deleteAllRejectedNews,
  deleteRejectedNewsById,
  getEditorRangeStats,
  renderRegistrationFieldsPage,
  renderReporterApplicationsPage,
  updateReporterApplication,
  renderPollsPage,
  createPollRest,
  deletePollRest,
  updatePollStatusRest,
  updatePollRest,
  renderReferralsPage,
  updateReferralStatus,
  getReporterDailyStats,
  getReporterPeriodStats,
  renderReporterWalletPage,
  renderWalletSettingsPage,
  getWalletSettings,
  updateWalletSettings,
  getReporterWalletTransactions,
  getReporterWalletSummary,
  getReporterWithdrawals,
  createReporterWithdrawal,
  cancelReporterWithdrawal,
  getReporterPayoutMethods,
  addReporterPayoutMethod,
  setDefaultReporterPayoutMethod,
  deleteReporterPayoutMethod,
  listWalletWithdrawals,
  processWalletWithdrawal,
  renderWithdrawalsQueuePage,
  renderWalletTransactionsPage,
  listWalletTransactionsAdmin,
  exportWalletTransactionsCsv,
  exportWalletTransactionsPdf,
  createWalletAdjustment,
  searchWalletReporters,
  renderAuditLogsPage,
  listAuditLogs,
  renderReporterAnalyticsPage,
  getReporterAnalyticsOverview,
  getReporterLeaderboard,
  getReporterLocationAnalytics,
  getReporterAnalyticsDetail,
  renderFraudAlertsPage,
  getFraudAlerts,
  getFraudLocationPosts,
  setWalletFreeze,
  setReporterSuspension,
  getReporterEngagement,
  renderMonthlyReportPage,
  getMonthlyReport,
  renderNewsMapPage,
  getNewsMapData,
  renderReporterHomeContentPage,
  getReporterHomeContentAdmin,
  updateReporterHomeContentAdmin,
  getReporterHomeBanner,
  uploadReporterHomeCardImage,
  renderReporterPopupsPage,
  getReporterPopupsAdmin,
  createReporterPopup,
  updateReporterPopup,
  deleteReporterPopup,
  getReporterPopupHistory,
  getReporterPopupTargetOptions,
  getActiveReporterPopups,
  ackReporterPopup,
  renderReporterGuidelinesPage,
  getReporterGuidelinesAdmin,
  updateReporterGuidelinesAdmin,
  getReporterGuidelines,
  renderReporterEarningPage,
  getReporterEarningAdmin,
  updateReporterEarningAdmin,
  getReporterEarning,
  uploadReporterEarningImage
};
