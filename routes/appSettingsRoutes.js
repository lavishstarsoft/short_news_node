const express = require('express');
const router = express.Router();
const AppSettings = require('../models/AppSettings');
const Language = require('../models/Language');
const { cacheMiddleware } = require('../middleware/cache');
const { requireAuth, requireAdmin } = require('../controllers/adminController');
const { NEWS_TITLE_MAX, NEWS_CONTENT_MAX } = require('../constants/newsLimits');
const { getQuizConfig } = require('../services/quizLanguageService');

// Admin route to get app settings view
router.get('/admin/app-settings', requireAuth, requireAdmin, async (req, res) => {
    try {
        let settings = await AppSettings.findOne({ key: 'update_flags' });
        if (!settings) {
            settings = await new AppSettings().save();
        }
        const languages = await Language.find({ isActive: true }).sort({ sortOrder: 1, name: 1 });
        res.render('app-settings', {
            admin: req.admin,
            activePage: 'app-settings',
            settings,
            languages
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
        const { androidVersion, iosVersion, forceUpdate, androidUpdateUrl, iosUpdateUrl, updateMessage, swipeStreakMilestone, isSwipeStreakEnabled, showLongVideos, showDistrictSelection, enableLocationModule, calendarEnabledLanguages, zodiacEnabledLanguages, contactUs, privacyPolicy, aboutUs, termsAndConditions, feedbackUrl, referralHelpText, referralRewardAmount, referralRequiredDays, maxDailyReferralBudget, referralShareUrl, isReferralEnabled, allowReporterBrowserAccess, enableAIAssistant } = req.body;
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
        if (swipeStreakMilestone !== undefined) settings.swipeStreakMilestone = parseInt(swipeStreakMilestone);
        if (isSwipeStreakEnabled !== undefined) settings.isSwipeStreakEnabled = isSwipeStreakEnabled;
        if (showLongVideos !== undefined) settings.showLongVideos = showLongVideos;
        if (showDistrictSelection !== undefined) settings.showDistrictSelection = showDistrictSelection;
        if (enableLocationModule !== undefined) settings.enableLocationModule = enableLocationModule;
        if (calendarEnabledLanguages !== undefined) settings.calendarEnabledLanguages = calendarEnabledLanguages;
        if (zodiacEnabledLanguages !== undefined) settings.zodiacEnabledLanguages = zodiacEnabledLanguages;

        
        // Update legal pages if provided
        if (contactUs !== undefined) settings.contactUs = contactUs;
        if (privacyPolicy !== undefined) settings.privacyPolicy = privacyPolicy;
        if (aboutUs !== undefined) settings.aboutUs = aboutUs;
        if (termsAndConditions !== undefined) settings.termsAndConditions = termsAndConditions;
        if (feedbackUrl !== undefined) settings.feedbackUrl = feedbackUrl;
        if (referralHelpText !== undefined) settings.referralHelpText = referralHelpText;
        if (referralRewardAmount !== undefined) settings.referralRewardAmount = Number(referralRewardAmount);
        if (referralRequiredDays !== undefined) settings.referralRequiredDays = Number(referralRequiredDays);
        if (maxDailyReferralBudget !== undefined) settings.maxDailyReferralBudget = Number(maxDailyReferralBudget);
        if (referralShareUrl !== undefined) settings.referralShareUrl = referralShareUrl;
        if (isReferralEnabled !== undefined) settings.isReferralEnabled = isReferralEnabled;

        // Superadmin-only: allow reporters site in normal browsers (dev)
        if (allowReporterBrowserAccess !== undefined && req.admin?.role === 'superadmin') {
            settings.allowReporterBrowserAccess = !!allowReporterBrowserAccess;
        }
        
        // Superadmin-only: enable AI Assistant widget
        if (enableAIAssistant !== undefined && req.admin?.role === 'superadmin') {
            settings.enableAIAssistant = !!enableAIAssistant;
        }

        await settings.save();
        res.json(settings);
    } catch (error) {
        console.error('Error updating app settings:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Public route to get app settings for mobile app (Cache removed for real-time updates)
router.get('/api/public/app-settings', async (req, res) => {
    try {
        let settings = await AppSettings.findOne({ key: 'update_flags' });
        let responseSettings = {};

        if (!settings) {
            // Return default values if not configured yet
            responseSettings = {
                androidVersion: '1.0.0',
                iosVersion: '1.0.0',
                forceUpdate: false,
                androidUpdateUrl: 'https://play.google.com/store/apps/details?id=com.lavish.yellowsingam',
                iosUpdateUrl: 'https://apps.apple.com/app/tehelka-news-daily-news-app/id6772203356',
                updateMessage: 'A new version of the app is available. Please update to continue.',
                swipeStreakMilestone: 30,
                isSwipeStreakEnabled: true,
                showLongVideos: true,
                showDistrictSelection: false,
                enableLocationModule: true,
                calendarEnabledLanguages: ['te'],
                zodiacEnabledLanguages: ['te'],
                quizEnabledLanguages: [], // empty = all languages
                isQuizEnabled: true,
                contactUs: '',
                privacyPolicy: '',
                aboutUs: '',
                termsAndConditions: '',
                referralHelpText: 'Invite your friends to earn rewards when they join and use the app for 7 days.',
                referralRewardAmount: 5,
                referralRequiredDays: 7,
                maxDailyReferralBudget: 5000,
                referralShareUrl: 'https://play.google.com/store/apps/details?id=com.lavish.yellowsingam',
                isReferralEnabled: true,
                allowReporterBrowserAccess: false,
                enableAIAssistant: true
            };
        } else {
            responseSettings = settings.toObject();
            if (responseSettings.calendarEnabledLanguages === undefined) {
                responseSettings.calendarEnabledLanguages = ['te', 'hi', 'en', 'ta', 'mr'];
            }
            if (responseSettings.zodiacEnabledLanguages === undefined) {
                responseSettings.zodiacEnabledLanguages = ['te', 'hi', 'en', 'ta', 'mr'];
            }
            if (responseSettings.quizEnabledLanguages === undefined) {
                responseSettings.quizEnabledLanguages = []; // empty = all languages (back-compat)
            }
            if (responseSettings.isQuizEnabled === undefined) {
                responseSettings.isQuizEnabled = true;
            }
            if (responseSettings.allowReporterBrowserAccess === undefined) {
                responseSettings.allowReporterBrowserAccess = false;
            }
            if (responseSettings.enableLocationModule === undefined) {
                responseSettings.enableLocationModule = true;
            }
            if (responseSettings.enableAIAssistant === undefined) {
                responseSettings.enableAIAssistant = true;
            }
        }

        // Override legacy Quiz settings with the new authoritative QuizSettings
        const quizConfig = await getQuizConfig();
        responseSettings.isQuizEnabled = quizConfig.isEnabled;
        responseSettings.quizEnabledLanguages = quizConfig.langs;
        // Admin-controlled feed positions: unplayed users vs users who already played today.
        responseSettings.quizFeedPosition = quizConfig.feedPosition;             // not played today
        responseSettings.quizFeedPositionPlayed = quizConfig.feedPositionPlayed; // already played today

        // Add length limits dynamically from backend constants
        responseSettings.newsTitleMax = NEWS_TITLE_MAX;
        responseSettings.newsContentMax = NEWS_CONTENT_MAX;

        res.json(responseSettings);
    } catch (error) {
        console.error('Error fetching public app settings:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Lightweight flag for reporters middleware (browser vs WebView-only)
router.get('/api/public/reporter-browser-access', cacheMiddleware(10), async (req, res) => {
    try {
        const settings = await AppSettings.findOne({ key: 'update_flags' }).select('allowReporterBrowserAccess').lean();
        res.json({
            allowReporterBrowserAccess: !!settings?.allowReporterBrowserAccess
        });
    } catch (error) {
        console.error('Error fetching reporter browser access flag:', error);
        res.status(500).json({ allowReporterBrowserAccess: false });
    }
});

module.exports = router;
