const express = require('express');
const router = express.Router();
const { requireAuth } = require('../controllers/adminController');
const longVideoController = require('../controllers/longVideoController');

// Render long videos page
router.get('/', requireAuth, (req, res) => {
    res.render('long-videos', { admin: req.admin });
});

// API routes for long videos
router.get('/api/videos', requireAuth, longVideoController.getAllLongVideos);
router.post('/api/videos', requireAuth, longVideoController.createLongVideo);
router.put('/api/videos/:id', requireAuth, longVideoController.updateLongVideo);
router.delete('/api/videos/:id', requireAuth, longVideoController.deleteLongVideo);
router.put('/api/videos/:id/toggle-status', requireAuth, longVideoController.toggleVideoStatus);

module.exports = router;
