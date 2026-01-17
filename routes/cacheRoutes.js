const express = require('express');
const router = express.Router();
const cacheController = require('../controllers/cacheController');
const { requireAuth, requireAdmin } = require('../controllers/adminController');

// All cache routes require admin authentication
// Cache management page
router.get('/management', requireAuth, cacheController.renderCacheManagementPage);

// API endpoints
router.get('/stats', requireAdmin, cacheController.getCacheStatistics);
router.post('/clear', requireAdmin, cacheController.clearAllCacheData);
router.post('/clear-pattern', requireAdmin, cacheController.clearCacheByPattern);
router.post('/reset-stats', requireAdmin, cacheController.resetStatistics);
router.get('/keys', requireAdmin, cacheController.getAllCacheKeys);
router.post('/warm', requireAdmin, cacheController.warmPopularCache);

module.exports = router;
