const express = require('express');
const router = express.Router();
const { requireAuth } = require('../controllers/adminController');
const viralVideoController = require('../controllers/viralVideoController');

const Language = require('../models/Language');
const Admin = require('../models/Admin');

// Render viral videos page
router.get('/', requireAuth, async (req, res) => {
    try {
        if (req.admin && req.admin.id) {
            const adminData = await Admin.findById(req.admin.id).select('workingLanguage').lean();
            if (adminData && adminData.workingLanguage) {
                req.admin.workingLanguage = adminData.workingLanguage;
            }
        }
        const languages = await Language.getActiveLanguages();
        res.render('viral-videos', { admin: req.admin, languages });
    } catch (err) {
        console.error('Error fetching languages:', err);
        res.render('viral-videos', { admin: req.admin, languages: [] });
    }
});

// API routes for viral videos
router.get('/api/videos', requireAuth, viralVideoController.getAllViralVideos);
router.post('/api/videos', requireAuth, viralVideoController.createViralVideo);
router.put('/api/videos/:id', requireAuth, viralVideoController.updateViralVideo);
router.delete('/api/videos/:id', requireAuth, viralVideoController.deleteViralVideo);
router.put('/api/videos/:id/toggle-status', requireAuth, viralVideoController.toggleVideoStatus);

module.exports = router;
