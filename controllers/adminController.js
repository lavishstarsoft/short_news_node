const Admin = require('../models/Admin');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const geoip = require('geoip-lite');
const requestIp = require('request-ip');
const iplocation = require('iplocation').default;
const fetch = require('node-fetch');
const mongoose = require('mongoose');

// Add these model imports
const News = require('../models/News');
const Location = require('../models/Location');
const Category = require('../models/Category');

// Import the Notification model
const Notification = require('../models/Notification');
const User = require('../models/User');

// Import OneSignal service
const oneSignalService = require('../services/oneSignalService');

// Import Similarity Detector
const { checkDuplicate, generateContentHash } = require('../utils/similarityDetector');

// Import cache clearing functionality
const { clearCache } = require('../middleware/cache');

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
      const ipLocationData = await iplocation(ip);
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
      { id: isConnectedToMongoDB ? admin._id : admin.id, username: admin.username, role: admin.role },
      process.env.JWT_SECRET || 'short_news_secret_key',
      { expiresIn: '24h' }
    );

    // Set cookie
    res.cookie('token', token, {
      httpOnly: true,
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

    // Get all users from database
    const users = await User.find().sort({ createdAt: -1 });

    // Aggregate likes from news
    const likesAgg = await News.aggregate([
      { $unwind: '$userInteractions.likes' },
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
      { $unwind: '$userInteractions.dislikes' },
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
      { $unwind: '$userInteractions.comments' },
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

    res.render('users', { admin, users: usersWithInteractions });
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
      } else {
        // Admins and superadmins see all news, but limit to latest 12
        newsList = await News.find().sort({ publishedAt: -1 }).limit(12);
        totalNewsCount = await News.countDocuments();
        activeNewsCount = await News.countDocuments({ isActive: true });
        inactiveNewsCount = await News.countDocuments({ isActive: false });
      }

      const categories = await Category.find();
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

// Render editors page
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
      const lifecycleStats = await News.aggregate([
        {
          $match: {
            authorId: { $in: editorIds }
          }
        },
        {
          $project: {
            authorId: 1,
            isActive: 1,
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
            }
          }
        }
      ]);

      lifecycleStats.forEach(item => {
        statsByEditor[item._id] = {
          submitted: item.submitted || 0,
          published: item.published || 0,
          pending: item.pending || 0,
          rejected: item.rejected || 0
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
          rejected: 0
        },
        latestRejection: latestRejectByEditor[editor._id.toString()] || null
      };
    });

    // Fetch locations for edit dropdown
    const locations = await Location.find().sort({ name: 1 });

    res.render('editors', { admin, editors: editorsWithStats, locations });
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

    const allowedPeriods = ['7', '30', '90', 'all'];
    const period = allowedPeriods.includes(req.query.period) ? req.query.period : '30';

    let sinceDate = null;
    if (period !== 'all') {
      sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - Number(period));
    }

    const members = await Admin.find({ role: { $in: ['editor', 'subeditor'] } })
      .select('_id username name email role displayRole isActive lastLogin location constituency')
      .sort({ createdAt: -1 })
      .lean();

    const memberIds = members.map((member) => member._id.toString());

    const newsMatch = {
      authorId: { $in: memberIds }
    };

    if (sinceDate) {
      newsMatch.publishedAt = { $gte: sinceDate };
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

    const summary = {
      totalMembers: rowsWithRank.length,
      totalSubEditors: subEditors.length,
      totalReporters: reporters.length,
      excellentCount: rowsWithRank.filter((row) => row.performanceBand === 'excellent').length,
      poorCount: rowsWithRank.filter((row) => row.performanceBand === 'poor').length,
      avgScore: rowsWithRank.length > 0
        ? Number((rowsWithRank.reduce((acc, row) => acc + row.performanceScore, 0) / rowsWithRank.length).toFixed(1))
        : 0
    };

    return res.render('performance-analytics', {
      admin,
      title: 'Performance Analytics',
      period,
      sinceDate,
      summary,
      analyticsRows: rowsWithRank,
      topPerformers,
      poorPerformers,
      recommendations: performanceRecommendations
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
    const { name, displayRole, location, constituency, mobileNumber, role } = req.body;

    const editor = await Admin.findById(editorId);
    if (!editor || (editor.role !== 'editor' && editor.role !== 'subeditor')) {
      return res.status(404).json({ error: 'Editor not found' });
    }

    // Update fields
    if (name !== undefined) editor.name = name || null;
    if (displayRole !== undefined) editor.displayRole = displayRole || 'Reporter';
    if (location !== undefined) editor.location = location || null;
    if (constituency !== undefined) editor.constituency = constituency || null;
    if (mobileNumber !== undefined) editor.mobileNumber = mobileNumber || null;

    // Update role if provided (only allow editor or subeditor)
    if (role !== undefined && (role === 'editor' || role === 'subeditor')) {
      editor.role = role;
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
        mobileNumber: editor.mobileNumber
      }
    });
  } catch (error) {
    console.error('Update editor error:', error);
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
    return res.status(500).json({ error: 'An error occurred while updating password' });
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

    res.render('register-editor', { admin, locations });
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

    const { username, email, password, name, displayRole, location, constituency, mobileNumber, role } = req.body;

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
      mobileNumber: mobileNumber || null,
      createdBy: admin._id
    });

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
    const { title, message, newsId, imageUrl, launchUrl, titleColor, platformSettings, priority } = req.body;

    // Validate input
    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required' });
    }

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
      title,
      message,
      newsId: newsId || null,
      imageUrl: imageUrl || null,
      launchUrl: finalLaunchUrl || null,
      titleColor: titleColor || null, // Include title color in WebSocket notification
      platformSettings: finalPlatformSettings,
      priority: priority || 'normal',
      timestamp: new Date()
    };

    // Emit to all connected clients
    io.emit('admin_notification', notificationData);

    // 🚀 MANUAL NEWS NOTIFICATION: If newsId provided, also emit new_news for instant app updates
    // Telugu: newsId ఉంటే app లో instant notification కోసం new_news event కూడా పంపుతాము
    if (newsId) {
      try {
        // Fetch full news details for proper new_news event
        const newsDetails = await News.findById(newsId).lean();
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
            imageUrl: newsDetails.imageUrl || newsDetails.mediaUrl // Backward compatibility
          };

          // Emit new_news event for instant app notification
          io.emit('new_news', newsNotificationData);
          console.log('📱 MANUAL: Sent new_news WebSocket event for instant app notification');
          console.log('🎯 News Title:', newsDetails.title);
        }
      } catch (newsError) {
        console.error('⚠️ Error fetching news details for WebSocket:', newsError);
      }
    }

    console.log('Sent admin notification to all clients:', notificationData);

    // Send OneSignal notification
    try {
      await oneSignalService.sendAdminNotification(title, message, {
        newsId: newsId || null,
        imageUrl: imageUrl || null,
        launchUrl: finalLaunchUrl || null,
        titleColor: titleColor || null,
        platformSettings: finalPlatformSettings,
        priority: priority || 'normal',
        ...notificationData
      });
      console.log('OneSignal admin notification sent');
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
      message: 'Notification sent successfully',
      notification: notificationData
    });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: 'Error sending notification: ' + error.message });
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
    res.status(500).json({ error: 'Error fetching notification stats: ' + error.message });
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
    res.status(500).json({ error: 'Error fetching notification: ' + error.message });
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
    res.status(500).json({ error: 'Error fetching notification history: ' + error.message });
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
    res.status(500).json({ error: 'Error fetching recent notifications: ' + error.message });
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
    res.status(500).json({ error: 'Error marking notification as opened: ' + error.message });
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
    res.status(500).json({ error: 'Error marking notification as received: ' + error.message });
  }
}

// Render notifications page with history
async function renderNotificationsPage(req, res) {
  try {
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
            totalReceived: { $sum: "$receivedRecipients" }
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
    res.status(500).json({ error: 'Error rendering notifications page: ' + error.message });
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
    res.status(500).json({ error: 'Error rendering OneSignal analytics page: ' + error.message });
  }
}

// Authentication middleware
const requireAuth = (req, res, next) => {
  console.log('requireAuth called for path:', req.path); // Debug log
  console.log('Auth Header:', req.headers.authorization); // Debug log
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

  console.log('Is API request:', isApiRequest); // Debug log

  if (!token) {
    console.log('No token found'); // Debug log
    if (isApiRequest) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'short_news_secret_key');
    console.log('Token verified, admin:', decoded.username); // Debug log
    req.admin = decoded;
    res.locals.admin = decoded;
    next();
  } catch (error) {
    console.log('Token verification failed:', error.message); // Debug log
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
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'short_news_secret_key');

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

// Check if user is admin or superadmin
const requireAdmin = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'short_news_secret_key');

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
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'short_news_secret_key');

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
    res.status(500).json({ error: 'Error deleting notification: ' + error.message });
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
    res.status(500).json({ error: 'Error deleting all notifications: ' + error.message });
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
    res.status(500).json({ error: 'Error fetching OneSignal analytics: ' + error.message });
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
      phone: user.phone || 'Not provided',
      profilePic: user.photoUrl || user.profilePic || '/images/default-avatar.png',
      createdAt: user.createdAt,
      userType: user.googleId ? 'Google User' : 'Standard User'
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
    res.status(500).send('Error loading R2 usage dashboard: ' + error.message);
  }
}

// Reporter/Editor API Login (for mobile/Next.js apps)
async function reporterLogin(req, res) {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Find admin/editor by username or email
    const admin = await Admin.findOne({
      $or: [{ username: username }, { email: username }]
    });

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
    const isMatch = await admin.comparePassword(password);
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
      process.env.JWT_SECRET || 'short_news_secret_key',
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
        profileImage: admin.profileImage
      }
    });
  } catch (error) {
    console.error('Get reporter profile error:', error);
    res.status(500).json({ error: 'An error occurred' });
  }
}

// Render pending news page for editors to review
async function renderPendingNewsPage(req, res) {
  try {
    // Fetch all pending news (isActive = false AND not rejected)
    const pendingNews = await News.find({
      isActive: false,
      $or: [
        { 'rejectionStatus.isRejected': { $ne: true } },
        { rejectionStatus: { $exists: false } }
      ]
    })
      .sort({ publishedAt: -1 })
      .lean();

    // Fetch all published articles for duplicate comparison
    const publishedArticles = await News.find({ isActive: true })
      .select('_id title content publishedAt author category location')
      .lean();

    // Check each pending article for duplicates
    const pendingNewsWithDuplicateCheck = pendingNews.map(article => {
      const duplicateResults = checkDuplicate(
        { title: article.title, content: article.content },
        publishedArticles
      );

      // Get top matches
      const topMatches = duplicateResults
        .filter(r => r.similarity.overall >= 50)
        .slice(0, 5);

      return {
        ...article,
        duplicateCheck: {
          isDuplicate: duplicateResults.some(r => r.isDuplicate),
          isSuspicious: duplicateResults.some(r => r.isSuspicious && !r.isDuplicate),
          score: topMatches.length > 0 ? topMatches[0].similarity.overall : 0,
          matchCount: topMatches.length,
          similarArticles: topMatches
        }
      };
    });

    res.render('pending-news', {
      pendingNews: pendingNewsWithDuplicateCheck || [],
      title: 'Pending News Review'
    });
  } catch (error) {
    console.error('Error rendering pending news page:', error);
    res.status(500).send('Error loading pending news');
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

    const normalizedTitle = (title || '').trim();
    const normalizedContent = (content || '').trim();
    const normalizedCategory = (category || '').trim();
    const normalizedLocation = typeof location === 'string' ? location.trim() : '';

    if (!normalizedTitle || !normalizedContent || !normalizedCategory) {
      return res.status(400).json({ error: 'Title, content and category are required' });
    }

    if (normalizedTitle.length > 55) {
      return res.status(400).json({ error: 'Title must be 55 characters or less' });
    }

    if (normalizedContent.length > 220) {
      return res.status(400).json({ error: 'Content must be 220 characters or less' });
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

    const adminId = req.adminId || req.userId || req.admin?.id || req.admin?._id?.toString();
    const adminName = req.admin?.username || req.admin?.name || 'Editor';

    let adminRole = 'Editor';
    if (req.admin?.role === 'superadmin' || req.admin?.role === 'admin') {
      adminRole = 'Admin';
    } else if (req.admin?.role === 'subeditor' || req.admin?.role === 'sub_editor') {
      adminRole = 'Sub Editor';
    } else if (req.admin?.role === 'editor') {
      adminRole = req.admin?.displayRole || 'Reporter';
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

    const updatedNews = await News.findByIdAndUpdate(
      id,
      {
        ...updatePayload,
        actionHistory
      },
      { new: true }
    ).lean();

    return res.json({
      success: true,
      message: 'Pending news updated successfully',
      news: updatedNews
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
      const admin = await Admin.findById(adminId).select('username role').lean();
      if (admin) {
        adminName = admin.username;
        // Format role for display
        if (admin.role === 'superadmin' || admin.role === 'admin') {
          adminRole = 'Admin';
        } else if (admin.role === 'subeditor' || admin.role === 'sub_editor') {
          adminRole = 'Sub Editor';
        } else if (admin.role === 'reporter') {
          adminRole = 'Reporter';
        } else {
          adminRole = admin.role ? admin.role.charAt(0).toUpperCase() + admin.role.slice(1) : 'Editor';
        }
      }
    }

    const existingNews = await News.findById(id).lean();
    if (!existingNews) {
      return res.status(404).json({ error: 'News not found' });
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

    // Update news to active with approval details
    const updatedNews = await News.findByIdAndUpdate(
      id,
      {
        isActive: true,
        approvalStatus: {
          isApproved: true,
          approvedBy: adminName,
          approvedByRole: adminRole,
          approvedAt: new Date()
        },
        actionHistory
      },
      { new: true }
    );

    if (!updatedNews) {
      return res.status(404).json({ error: 'News not found' });
    }

    // 🐦 X-STYLE IN-APP NOTIFICATION: WebSocket event for instant app notification
    // Telugu: Admin news create/approve చేసిన వెంటనే app లో X-style notification రావాలి
    //
    // What happens:
    // 1. WebSocket 'new_news' event → App gets instant notification
    // 2. App shows X-style "కొత్త వార్తలు వచ్చాయి!" banner
    // 3. User taps → Sees new news
    //
    // Note: This is IN-APP notification only, NOT push notification
    // Push notifications are still manual via bell button
    const io = req.app.locals.io;
    if (io) {
      // Prepare notification data for real-time in-app notification
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
        isApproved: true // Flag to distinguish from new pending submissions
      };

      // Emit to all connected clients for X-style in-app notification (Flutter)
      // admin-notifications.js will skip this because isApproved = true
      io.emit('news_published', notificationData);
      console.log('🐦 X-STYLE: Sent in-app notification to all connected clients');
      console.log('📰 News Title:', updatedNews.title);
      console.log('📱 App will show "కొత్త వార్తలు వచ్చాయి!" notification');
    } else {
      console.log('⚠️ WebSocket io not available for in-app notifications');
    }

    // 🔄 Clear news cache after approving news to ensure fresh data
    try {
      await clearCache('cache:/api/public/news*');
      await clearCache('cache:/api/public/locations*');
      console.log('🗂️ Cache cleared after news approval');
    } catch (cacheError) {
      console.log('⚠️ Cache clearing failed (non-critical):', cacheError.message);
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

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid news ID' });
    }

    // Get admin/editor name and role
    const adminId = req.adminId || req.userId || req.admin?.id || req.admin?._id?.toString();
    let adminName = 'Editor';
    let adminRole = 'Editor';

    if (adminId) {
      const admin = await Admin.findById(adminId).select('username role').lean();
      if (admin) {
        adminName = admin.username;
        // Format role for display
        if (admin.role === 'superadmin' || admin.role === 'admin') {
          adminRole = 'Admin';
        } else if (admin.role === 'subeditor' || admin.role === 'sub_editor') {
          adminRole = 'Sub Editor';
        } else if (admin.role === 'reporter') {
          adminRole = 'Reporter';
        } else {
          adminRole = admin.role ? admin.role.charAt(0).toUpperCase() + admin.role.slice(1) : 'Editor';
        }
      }
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

    // Mark article as rejected instead of deleting
    const rejectedNews = await News.findByIdAndUpdate(
      id,
      {
        isActive: false, // Keep as inactive
        rejectionStatus: {
          isRejected: true,
          reason: reason || 'Not Specified',
          feedback: feedback || 'No additional feedback',
          rejectedBy: adminName,
          rejectedByRole: adminRole,
          rejectedAt: new Date()
        },
        actionHistory
      },
      { new: true }
    );

    if (!rejectedNews) {
      return res.status(404).json({ error: 'News not found' });
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

// Check for duplicate articles
async function checkDuplicateArticles(req, res) {
  try {
    const { title, content } = req.body;

    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content required' });
    }

    // Fetch all existing articles (published and pending)
    const allArticles = await News.find({})
      .select('_id title content publishedAt author category location')
      .lean();

    // Check for duplicates
    const newArticle = { title, content };
    const duplicateResults = checkDuplicate(newArticle, allArticles);

    // Filter significant matches (>50% similarity)
    const significantMatches = duplicateResults
      .filter(result => result.similarity.overall >= 50)
      .slice(0, 10); // Top 10 matches

    res.json({
      success: true,
      hasDuplicate: duplicateResults.some(r => r.isDuplicate),
      isSuspicious: duplicateResults.some(r => r.isSuspicious),
      similarArticles: significantMatches,
      totalMatches: duplicateResults.length
    });
  } catch (error) {
    console.error('Error checking duplicates:', error);
    res.status(500).json({ error: 'Failed to check for duplicates' });
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
    // Fetch all rejected news
    const rejectedNews = await News.find({
      'rejectionStatus.isRejected': true
    })
      .sort({ 'rejectionStatus.rejectedAt': -1 })
      .select('title author category location publishedAt rejectionStatus isActive views')
      .lean();

    res.render('rejected-news', {
      title: 'Rejected News',
      rejectedNews: rejectedNews || [],
      totalRejected: rejectedNews.length
    });
  } catch (error) {
    console.error('Error rendering rejected news page:', error);
    res.status(500).send('Error loading rejected news');
  }
}

module.exports = {
  renderLoginPage,
  login,
  logout,
  requireAuth,
  requireAdmin,
  requireEditor,
  renderDashboard,
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
  renderUsersListPage,
  getUserById,
  renderReportsPage, // Add this back
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
  updatePendingNews,
  approveNews,
  rejectNews,
  checkDuplicateArticles,
  renderPlagiarismReportPage,
  getDuplicateDetails,
  renderRejectedNewsPage
};