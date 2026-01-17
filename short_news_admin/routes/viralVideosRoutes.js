const express = require('express');
const router = express.Router();
const { requireAuth } = require('../controllers/adminController');
const viralVideoController = require('../controllers/viralVideoController');

// Render viral videos page
router.get('/', requireAuth, (req, res) => {
    res.render('viral-videos', { admin: req.admin });
});

// API routes for viral videos
router.get('/api/videos', requireAuth, viralVideoController.getAllViralVideos);
router.post('/api/videos', requireAuth, viralVideoController.createViralVideo);
router.put('/api/videos/:id', requireAuth, viralVideoController.updateViralVideo);
router.delete('/api/videos/:id', requireAuth, viralVideoController.deleteViralVideo);
router.put('/api/videos/:id/toggle-status', requireAuth, viralVideoController.toggleVideoStatus);

module.exports = router;
