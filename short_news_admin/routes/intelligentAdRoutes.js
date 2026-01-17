const express = require('express');
const router = express.Router();
const intelligentAdController = require('../controllers/intelligentAdController');
const { requireAuth } = require('../controllers/adminController');

// Admin routes - Apply auth middleware
router.get('/', requireAuth, intelligentAdController.renderIntelligentAdsPage);
router.put('/ads/:id/frequency', requireAuth, intelligentAdController.updateAdFrequency);
router.get('/analytics', requireAuth, intelligentAdController.getAdAnalytics);
router.post('/analytics/reset', requireAuth, intelligentAdController.resetAdAnalytics);

module.exports = router;