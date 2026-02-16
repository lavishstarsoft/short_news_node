const News = require('../models/News');
const Location = require('../models/Location');
const Category = require('../models/Category');

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

// Render dashboard page
async function renderDashboard(req, res) {
  try {
    let totalNewsCount = 0;
    let activeNewsCount = 0;
    let inactiveNewsCount = 0;
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
      totalNewsCount = newsData.length;
      activeNewsCount = newsData.filter(news => news.isActive !== false).length;
      inactiveNewsCount = newsData.filter(news => news.isActive === false).length;

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

// Render news list page with filtering capabilities
async function renderNewsListPage(req, res) {
  console.log('renderNewsListPage called'); // Debug log
  try {
    if (req.app.locals.isConnectedToMongoDB) {
      console.log('Using MongoDB'); // Debug log
      let newsList;
      let locations;
      let selectedLocation = req.query.location || '';
      let selectedStatus = req.query.status || '';

      // Build query based on filters
      const query = {};

      // Location filter
      if (selectedLocation) {
        query.location = selectedLocation;
      }

      // Status filter
      if (selectedStatus === 'active') {
        query.isActive = true;
      } else if (selectedStatus === 'inactive') {
        query.isActive = false;
      }

      // Check user role
      if (req.admin.role === 'editor') {
        // Editors only see their own news
        query.authorId = req.admin.id;
      }

      newsList = await News.find(query).sort({ publishedAt: -1 });

      // Get all locations for the filter dropdown
      locations = await Location.find();

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

      console.log('Rendering news-list with', newsListWithCodes.length, 'news items'); // Debug log
      res.render('news-list', {
        newsList: newsListWithCodes,
        locations,
        selectedLocation,
        selectedStatus,
        admin: req.admin
      });
    } else {
      console.log('Using in-memory storage'); // Debug log
      // Use in-memory storage
      const newsData = req.app.locals.newsData || [];
      const locationData = req.app.locals.locationData || [];
      const selectedLocation = req.query.location || '';
      const selectedStatus = req.query.status || '';

      // Filter news by location if specified
      let filteredNewsData = newsData;

      // Location filter
      if (selectedLocation) {
        filteredNewsData = filteredNewsData.filter(news => news.location === selectedLocation);
      }

      // Status filter
      if (selectedStatus === 'active') {
        filteredNewsData = filteredNewsData.filter(news => news.isActive !== false);
      } else if (selectedStatus === 'inactive') {
        filteredNewsData = filteredNewsData.filter(news => news.isActive === false);
      }

      // Check user role
      if (req.admin.role === 'editor') {
        // Editors only see their own news
        filteredNewsData = filteredNewsData.filter(news => news.authorId === req.admin.id);
      }

      // Sort by published date
      filteredNewsData.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

      // Get all locations to create a map of name to code (for in-memory storage)
      const locationMap = {};
      locationData.forEach(location => {
        locationMap[location.name] = location.code;
      });

      // Add location codes to news items (for in-memory storage)
      const newsListWithCodes = filteredNewsData.map(news => {
        return {
          ...news,
          locationCode: news.location ? locationMap[news.location] : null
        };
      });

      console.log('Rendering news-list with', newsListWithCodes.length, 'news items'); // Debug log
      res.render('news-list', {
        newsList: newsListWithCodes,
        locations: locationData,
        selectedLocation,
        selectedStatus,
        admin: req.admin
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

    res.json(news);
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

    // Add author information and explicit timestamp to the news
    const newsData = {
      ...req.body,
      author: req.admin.username,
      authorId: req.admin.id,
      publishedAt: new Date() // Explicitly set the timestamp
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

    const news = new News(newsData);
    await news.save();

    // Send WebSocket notification to all connected clients
    const io = req.app.locals.io;
    const connectedClients = req.app.locals.connectedClients;

    if (io && connectedClients) {
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
        thumbnailUrl: news.thumbnailUrl
      };

      // Emit to all connected clients
      io.emit('new_news', notificationData);
      console.log('Sent new news notification to all clients');

      // Get all users to track recipients
      let allUsers = [];
      if (req.app.locals.isConnectedToMongoDB) {
        allUsers = await User.find({}, '_id');
      }

      // Create recipients list from connected clients
      const recipients = [];
      if (connectedClients) {
        for (let [userId, socketId] of connectedClients.entries()) {
          recipients.push({
            userId: userId,
            received: false,
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
        title: `New News: ${news.title}`,
        message: news.content.substring(0, 100) + (news.content.length > 100 ? '...' : ''),
        type: 'news',
        priority: 'normal',
        newsId: news._id,
        recipients: recipients,
        sentBy: 'System'
      });

      if (req.app.locals.isConnectedToMongoDB) {
        await notification.save();
        console.log('Saved news notification to database with ID:', notification._id);
      }

      // Send OneSignal notification
      try {
        await oneSignalService.sendNewsNotification(news);
        console.log('OneSignal notification sent for new news');
      } catch (error) {
        console.error('Error sending OneSignal notification:', error);
      }
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

    // Add author information to the update (in case it's missing)
    // Note: We don't update the publishedAt timestamp when editing news
    const newsData = {
      ...req.body,
      author: req.admin.username,
      authorId: req.admin.id
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
      const news = await News.findByIdAndUpdate(
        id,
        { isActive: isActive },
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
      // For images, use the uploaded file as both media and thumbnail
      return res.json({
        mediaUrl: fileUrl,
        thumbnailUrl: fileUrl,
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