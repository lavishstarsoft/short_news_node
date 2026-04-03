const News = require('../models/News');
const Location = require('../models/Location');
const Category = require('../models/Category');
const Admin = require('../models/Admin'); // Add Admin model for denormalization

const path = require('path');
const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

// Import the Notification and User models
const Notification = require('../models/Notification');
const User = require('../models/User');

// Import OneSignal service
const oneSignalService = require('../services/oneSignalService');

// Import cache middleware for cache invalidation
const { clearCache } = require('../middleware/cache');

// Import Cloudflare R2 deletion utility
const { deleteFromR2 } = require('../config/cloudflare');

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

      // Check user role
      if (req.admin.role === 'editor') {
        // Editors only see their own news
        newsList = await News.find({ authorId: req.admin.id }).sort({ publishedAt: -1 }).limit(12);
        totalNewsCount = await News.countDocuments({ authorId: req.admin.id });
        activeNewsCount = await News.countDocuments({ authorId: req.admin.id, isActive: true });
        inactiveNewsCount = await News.countDocuments({ authorId: req.admin.id, isActive: false });
        pendingNewsCount = await News.countDocuments({
          authorId: req.admin.id,
          isActive: false,
          'rejectionStatus.isRejected': { $ne: true }
        });
      } else {
        // Admins and superadmins see all news, but limit to latest 12
        newsList = await News.find().sort({ publishedAt: -1 }).limit(12);
        totalNewsCount = await News.countDocuments();
        activeNewsCount = await News.countDocuments({ isActive: true });
        inactiveNewsCount = await News.countDocuments({ isActive: false });
        pendingNewsCount = await News.countDocuments({
          isActive: false,
          'rejectionStatus.isRejected': { $ne: true }
        });
      }

      const categories = await Category.find();
      const locations = await Location.find();

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

      // Add location codes to news items
      const newsListWithCodes = newsList.map(news => {
        return {
          ...news.toObject(),
          locationCode: news.location ? locationMap[news.location] : null,
          authorRole: authorRoleMap[news.authorId] || 'Reporter',
          authorSystemRole: authorSystemRoleMap[news.authorId] || 'editor'
        };
      });

      // Calculate today's news count
      const today = new Date();
      today.setHours(0, 0, 0, 0);

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
        pendingNewsCount,
        admin: req.admin
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

      res.render('index', {
        newsList: newsListWithCodes,
        categories: categoryData,
        locations: locationData,
        todaysNewsCount,
        totalNewsCount,
        activeNewsCount,
        inactiveNewsCount,
        pendingNewsCount,
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

    if (req.app.locals.isConnectedToMongoDB) {
      console.log('Using MongoDB'); // Debug log
      let newsList;
      let locations;
      let selectedLocation = req.query.location || '';
      let selectedStatus = req.query.status || '';

      // Build query based on filters
      const query = {};

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
      } else if (selectedStatus === 'pending') {
        query.isActive = false;
        query['rejectionStatus.isRejected'] = { $ne: true };
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

      // Check user role
      if (req.admin.role === 'editor') {
        // Editors only see their own news
        query.authorId = req.admin.id;
      } else if (selectedAuthorId) {
        query.authorId = selectedAuthorId;
      }

      // Get total count for pagination
      const totalNews = await News.countDocuments(query);
      const totalPages = Math.ceil(totalNews / limit);

      // Fetch only the news for current page with pagination
      newsList = await News.find(query)
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(limit);

      // Get all locations for the filter dropdown
      locations = await Location.find();

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

      // Add location codes to news items
      const newsListWithCodes = newsList.map(news => {
        return {
          ...news.toObject(),
          locationCode: news.location ? locationMap[news.location] : null,
          authorRole: authorRoleMap[news.authorId] || 'Reporter',
          authorSystemRole: authorSystemRoleMap[news.authorId] || 'editor'
        };
      });

      console.log('Rendering news-list with', newsListWithCodes.length, 'news items, page', page, 'of', totalPages); // Debug log
      res.render('news-list', {
        newsList: newsListWithCodes,
        locations,
        selectedLocation,
        selectedStatus,
        selectedAuthorId,
        searchQuery,
        fromDate,
        toDate,
        admin: req.admin,
        pagination: {
          currentPage: page,
          totalPages,
          totalNews,
          limit,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1
        }
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
        filteredNewsData = filteredNewsData.filter(news => news.isActive === false);
      } else if (selectedStatus === 'pending') {
        filteredNewsData = filteredNewsData.filter(news =>
          news.isActive === false && !(news.rejectionStatus && news.rejectionStatus.isRejected)
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
        selectedAuthorId,
        searchQuery,
        fromDate,
        toDate,
        admin: req.admin,
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

    res.json({
      ...news.toObject(),
      authorRole: getAuthorRoleLabel(author),
      authorSystemRole: author?.role || 'editor'
    });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching news' });
  }
}

// Render add news page
function renderAddNewsPage(req, res) {
  res.render('add-news', { admin: req.admin });
}

// Render edit news page
async function renderEditNewsPage(req, res) {
  try {
    const news = await News.findById(req.params.id);
    if (!news) {
      return res.status(404).json({ error: 'News not found' });
    }

    // Check if editor is trying to edit someone else's news
    if (req.admin.role === 'editor' && news.authorId !== req.admin.id) {
      return res.status(403).json({ error: 'Access denied. You can only edit your own news.' });
    }

    res.render('add-news', { news, admin: req.admin });
  } catch (error) {
    res.status(500).json({ error: 'Error fetching news for editing' });
  }
}

// Create new news (include author information)
async function createNews(req, res) {
  try {
    // Validation
    if (req.body.title && req.body.title.length > 55) {
      return res.status(400).json({ error: 'Title cannot exceed 55 characters' });
    }
    if (req.body.content && req.body.content.length > 220) {
      return res.status(400).json({ error: 'Content cannot exceed 220 characters' });
    }

    // Fetch author details for denormalization
    const authorDetails = await Admin.findById(req.admin.id).select('profileImage constituency');

    // Add author information and explicit timestamp to the news
    const newsData = {
      ...req.body,
      author: req.admin.username,
      authorId: req.admin.id,
      authorProfileImage: authorDetails?.profileImage || null,
      authorConstituency: authorDetails?.constituency || null,
      actionHistory: [
        buildHistoryEntry('created', req.admin, 'News article created', {
          title: req.body.title,
          category: req.body.category,
          location: req.body.location || null
        })
      ],
      publishedAt: new Date() // Explicitly set the timestamp
    };

    // Role-based isActive:
    // Reporter (editor role) → isActive: false → goes to Pending News (needs admin approval)
    // Admin / Sub-Editor / SuperAdmin → isActive: true → directly published to News List

    // ✅ Direct Publish Roles: admin, superadmin, subeditor
    const directPublishRoles = ['admin', 'superadmin', 'subeditor'];

    if (directPublishRoles.includes(req.admin.role)) {
      newsData.isActive = true;   // → Direct Publish (No Pending)
    } else {
      newsData.isActive = false;  // → Pending News (Reporter/Editor approval needed)
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
    await news.save();

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
        mediaType: news.mediaType,
        mediaUrl: news.mediaUrl,
        thumbnailUrl: news.thumbnailUrl,
        imageUrl: news.imageUrl || news.mediaUrl
      };

      // ✅ Direct Publish Roles: admin, superadmin, subeditor
      const directPublishRoles = ['admin', 'superadmin', 'subeditor'];

      if (directPublishRoles.includes(req.admin.role)) {
        // ✅ ADMIN/SUB-EDITOR/SUPERADMIN published news → No pending notification, direct publish
        // Emit different event for Flutter app (Twitter-style pill) without triggering admin pending sound
        io.emit('news_published', notificationData);
        console.log('✅ PUBLISHED: Admin/Sub-Editor/SuperAdmin news published directly:', news.title);
      } else {
        // 🔔 REPORTER submitted news → Send pending notification to admin dashboard (sound + toast)
        io.emit('new_news', notificationData);
        console.log('🔔 PENDING: Reporter submitted news, admin notified:', news.title);
      }
    } else {
      console.log('⚠️ WebSocket io not available');
    }

    // 🔄 Clear news cache after creating new news
    await clearCache('cache:/api/public/news*');
    await clearCache('cache:/api/public/locations*');

    // Send JSON response for API calls
    res.status(201).json(news);
  } catch (error) {
    console.error('Error creating news:', error);
    res.status(400).json({ error: 'Error creating news: ' + error.message });
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

    // Check if editor is trying to update someone else's news
    if (req.admin.role === 'editor' && existingNews.authorId !== req.admin.id) {
      return res.status(403).json({ error: 'Access denied. You can only update your own news.' });
    }

    // Validation
    if (req.body.title && req.body.title.length > 55) {
      return res.status(400).json({ error: 'Title cannot exceed 55 characters' });
    }
    if (req.body.content && req.body.content.length > 220) {
      return res.status(400).json({ error: 'Content cannot exceed 220 characters' });
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
      author: req.admin.username,
      authorId: req.admin.id,
      authorProfileImage: authorDetails?.profileImage || null,
      authorConstituency: authorDetails?.constituency || null,
      actionHistory: updatedHistory,
    };

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
    // First, find the news to check ownership
    const existingNews = await News.findById(req.params.id);
    if (!existingNews) {
      return res.status(404).json({ error: 'News not found' });
    }

    // Check if editor is trying to delete someone else's news
    if (req.admin.role === 'editor' && existingNews.authorId !== req.admin.id) {
      return res.status(403).json({ error: 'Access denied. You can only delete your own news.' });
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

      // Check if editor is trying to toggle someone else's news
      if (req.admin.role === 'editor' && existingNews.authorId !== req.admin.id) {
        console.log('Editor trying to toggle someone else\'s news:', {
          editorId: req.admin.id,
          newsAuthorId: existingNews.authorId
        }); // Debug log
        return res.status(403).json({ error: 'Access denied. You can only toggle your own news.' });
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

      // Toggle the isActive status
      newsData[newsIndex].isActive = isActive;
      if (!Array.isArray(newsData[newsIndex].actionHistory)) {
        newsData[newsIndex].actionHistory = [];
      }
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
    res.status(500).json({ error: 'Error updating news status: ' + error.message });
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

    // For videos, Cloudinary automatically generates thumbnails
    if (fileType === 'video') {
      // Cloudinary allows getting a thumbnail by changing the file extension to .jpg
      // Example: .../video/upload/v123456/folder/video.mp4 -> .../video/upload/v123456/folder/video.jpg
      const thumbnailUrl = fileUrl.replace(/\.[^/.]+$/, ".jpg");

      return res.json({
        mediaUrl: fileUrl,
        thumbnailUrl: thumbnailUrl,
        fileType: fileType
      });
    } else {
      // For images, use the generated thumbnail if available
      return res.json({
        mediaUrl: fileUrl,
        thumbnailUrl: req.file.thumbnailPath || fileUrl,
        fileType: fileType
      });
    }
  } catch (error) {
    console.error('Media upload error:', error);
    res.status(500).json({ error: 'Error uploading media: ' + error.message });
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
  toggleNewsStatus,
  updateNews,
  deleteNews,
  uploadMedia
};