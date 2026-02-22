const express = require('express');
const router = express.Router();
const AppSettings = require('../models/AppSettings');
const { cacheMiddleware } = require('../middleware/cache');
const { requireAuth, requireAdmin } = require('../controllers/adminController');

// Admin route to get app settings view
router.get('/admin/app-settings', requireAuth, requireAdmin, async (req, res) => {
    try {
        let settings = await AppSettings.findOne({ key: 'update_flags' });
        if (!settings) {
            settings = await new AppSettings().save();
        }
        res.render('app-settings', {
            admin: req.admin,
            activePage: 'app-settings',
            settings
        });
    } catch (error) {
        console.error('Error fetching app settings view:', error);
        res.status(500).send('Server Error');
    }
});

// Admin route to get app settings (JSON)
router.get('/api/admin/app-settings', requireAuth, requireAdmin, async (req, res) => {
    try {
        let settings = await AppSettings.findOne({ key: 'update_flags' });
        if (!settings) {
            settings = await new AppSettings().save();
        }
        res.json(settings);
    } catch (error) {
        console.error('Error fetching app settings:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Admin route to update app settings
router.put('/api/admin/app-settings', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { androidVersion, iosVersion, forceUpdate, androidUpdateUrl, iosUpdateUrl, updateMessage } = req.body;
        let settings = await AppSettings.findOne({ key: 'update_flags' });

        if (!settings) {
            settings = new AppSettings();
        }

        // Update fields if provided
        if (androidVersion !== undefined) settings.androidVersion = androidVersion;
        if (iosVersion !== undefined) settings.iosVersion = iosVersion;
        if (forceUpdate !== undefined) settings.forceUpdate = forceUpdate;
        if (androidUpdateUrl !== undefined) settings.androidUpdateUrl = androidUpdateUrl;
        if (iosUpdateUrl !== undefined) settings.iosUpdateUrl = iosUpdateUrl;
        if (updateMessage !== undefined) settings.updateMessage = updateMessage;

        await settings.save();
        res.json(settings);
    } catch (error) {
        console.error('Error updating app settings:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Public route to get app settings for mobile app (Cached for 5 mins)
router.get('/api/public/app-settings', cacheMiddleware(300), async (req, res) => {
    try {
        let settings = await AppSettings.findOne({ key: 'update_flags' });
        if (!settings) {
            // Return default values if not configured yet
            return res.json({
                androidVersion: '1.0.0',
                iosVersion: '1.0.0',
                forceUpdate: false,
                androidUpdateUrl: 'https://play.google.com/store/apps/details?id=com.lavish.yellowsingam',
                iosUpdateUrl: '',
                updateMessage: 'A new version of the app is available. Please update to continue.'
            });
        }
        res.json(settings);
    } catch (error) {
        console.error('Error fetching public app settings:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
