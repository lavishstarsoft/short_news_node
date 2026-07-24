const express = require('express');
const router = express.Router();
const newsController = require('../controllers/newsController');
const { requireAuth } = require('../controllers/adminController');
const { checkLanguageMismatch } = require('../middleware/languageCheck');

// Import Cloudinary upload middleware
const { uploadMedia, uploadAdMedia } = require('../middleware/upload');

// API routes - Apply auth middleware only to routes that need it
router.get('/api/news', requireAuth, newsController.getAllNews);
router.get('/api/news/:id', requireAuth, newsController.getNewsById);
router.post('/api/news', requireAuth, checkLanguageMismatch, newsController.createNews);
// Move toggle-status route to be more specific and avoid conflicts
router.put('/api/news/:id/toggle-status', requireAuth, newsController.toggleNewsStatus);
router.put('/api/news/:id/views', requireAuth, newsController.updateViewCount);
router.put('/api/news/:id/likes', requireAuth, newsController.updateLikeCount);
router.put('/api/news/:id/dislikes', requireAuth, newsController.updateDislikeCount);
router.put('/api/news/:id/comments/:commentId', requireAuth, newsController.updateNewsComment);
router.delete('/api/news/:id/comments/:commentId', requireAuth, newsController.deleteNewsComment);
router.put('/api/news/:id', requireAuth, checkLanguageMismatch, newsController.updateNews);
router.post('/api/news/:id/resubmit', requireAuth, checkLanguageMismatch, newsController.resubmitNews);
router.delete('/api/news/:id', requireAuth, newsController.deleteNews);

// Image moderation route
router.post('/api/news/process-image', requireAuth, newsController.processImage);

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
