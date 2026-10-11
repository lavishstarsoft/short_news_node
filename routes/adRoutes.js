const express = require('express');
const router = express.Router();
const adController = require('../controllers/adController');
const { requireAuth } = require('../controllers/adminController');

// Admin routes - Apply auth middleware
// Removed the root route '/' to avoid conflict with intelligent ads route
router.get('/ads', requireAuth, adController.renderAdsListPage);
router.get('/add-ad', requireAuth, adController.renderAddAdPage);
router.get('/edit-ad/:id', requireAuth, adController.renderEditAdPage);
router.post('/ads', requireAuth, adController.createAd);
router.put('/ads/:id', requireAuth, adController.updateAd);
router.delete('/ads/:id', requireAuth, adController.deleteAd);
router.put('/ads/:id/toggle-status', requireAuth, adController.toggleAdStatus);

// Per-language ad-frequency stats for the add/edit interval hint (auth-gated).
router.get('/api/lang-stats', requireAuth, adController.langStats);
// Auto-fix: re-space all of a language's ads to a comfortable frequency.
router.post('/api/auto-balance', requireAuth, adController.autoBalance);

// Public API route for fetching active ads
router.get('/api/public/ads', adController.getActiveAds);
router.post('/record-interaction', adController.recordAdInteraction);

module.exports = router;