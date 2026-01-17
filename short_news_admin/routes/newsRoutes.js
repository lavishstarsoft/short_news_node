const express = require('express');
const router = express.Router();
const newsController = require('../controllers/newsController');
const { requireAuth } = require('../controllers/adminController');

// Import Cloudinary upload middleware
const { uploadMedia, uploadAdMedia } = require('../middleware/upload');

// Test routes
router.get('/test-public', (req, res) => {
  res.send('Public test route working');
});

router.get('/test-view', (req, res) => {
  res.render('test');
});

// Test route for debugging toggle functionality
router.get('/test-toggle/:id', async (req, res) => {
  try {
    console.log('Test toggle called with ID:', req.params.id);
    console.log('Admin:', req.admin);

    // Check if using MongoDB or in-memory storage
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    console.log('Using MongoDB:', isConnectedToMongoDB);

    if (isConnectedToMongoDB) {
      const News = require('../models/News');
      const news = await News.findById(req.params.id);
      console.log('News found in MongoDB:', news);
      if (news) {
        const updatedNews = await News.findByIdAndUpdate(
          req.params.id,
          { isActive: !news.isActive },
          { new: true }
        );
        res.json({ message: 'Toggle successful', news: updatedNews });
      } else {
        res.status(404).json({ error: 'News not found' });
      }
    } else {
      const newsData = req.app.locals.newsData;
      const newsIndex = newsData.findIndex(news => news._id === req.params.id);
      console.log('News index in in-memory storage:', newsIndex);
      if (newsIndex !== -1) {
        newsData[newsIndex].isActive = !newsData[newsIndex].isActive;
        res.json({ message: 'Toggle successful', news: newsData[newsIndex] });
      } else {
        res.status(404).json({ error: 'News not found' });
      }
    }
  } catch (error) {
    console.error('Test toggle error:', error);
    res.status(500).json({ error: 'Error toggling news status: ' + error.message });
  }
});

// API routes - Apply auth middleware only to routes that need it
router.get('/api/news', requireAuth, newsController.getAllNews);
router.get('/api/news/:id', requireAuth, newsController.getNewsById);
router.post('/api/news', requireAuth, newsController.createNews);
// Move toggle-status route to be more specific and avoid conflicts
router.put('/api/news/:id/toggle-status', requireAuth, newsController.toggleNewsStatus);
router.put('/api/news/:id', requireAuth, newsController.updateNews);
router.delete('/api/news/:id', requireAuth, newsController.deleteNews);

// Media upload routes - Apply auth middleware
router.post('/upload-media', requireAuth, uploadMedia.single('media'), newsController.uploadMedia);
// New route for ad media upload - preserves exact crop from admin (no transformation)
router.post('/upload-ad-media', requireAuth, uploadAdMedia.single('media'), newsController.uploadMedia);

// Dashboard routes - Apply auth middleware
router.get('/', requireAuth, newsController.renderDashboard);
router.get('/news-list', requireAuth, newsController.renderNewsListPage); // New route for news list
router.get('/add-news', requireAuth, newsController.renderAddNewsPage);
router.get('/edit-news/:id', requireAuth, newsController.renderEditNewsPage);
router.get('/reports', requireAuth, newsController.renderReportsPage); // Route for reports page

module.exports = router;
