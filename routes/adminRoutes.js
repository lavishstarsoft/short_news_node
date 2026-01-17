const express = require('express');
const adminController = require('../controllers/adminController');

const router = express.Router();

// Admin authentication routes
router.get('/login', adminController.renderLoginPage);
router.post('/login', adminController.login);
router.get('/logout', adminController.logout);

// Admin dashboard routes
router.get('/dashboard', adminController.requireAuth, adminController.renderDashboard);
router.get('/profile', adminController.requireAuth, adminController.renderProfilePage);
router.put('/profile', adminController.requireAuth, adminController.updateProfile);

// Admin management routes
router.get('/register-editor', adminController.requireAdmin, adminController.renderRegisterEditorPage);
router.post('/register-editor', adminController.requireAdmin, adminController.registerEditor);
router.get('/editors', adminController.requireAuth, adminController.renderEditorsPage);

// User management routes
router.get('/users', adminController.requireAuth, adminController.renderUsersListPage);
router.get('/users/:id', adminController.requireAuth, adminController.getUserById); // Add this route

// Reports routes
router.get('/reports', adminController.requireAuth, adminController.renderReportsPage);

// Notification routes
router.get('/notifications', adminController.requireAuth, adminController.renderNotificationsPage);
router.get('/onesignal-analytics', adminController.requireAuth, adminController.renderOneSignalAnalyticsPage);
router.post('/api/send-notification', adminController.requireAuth, adminController.sendNotification);
router.get('/api/notifications/history', adminController.requireAuth, adminController.getNotificationHistory);
router.get('/api/notifications/stats', adminController.requireAuth, adminController.getNotificationStats);
router.get('/api/notifications/recent', adminController.requireAuth, adminController.getRecentNotifications);
router.get('/api/notifications/:id', adminController.requireAuth, adminController.getNotificationById);
router.delete('/api/notifications/:id', adminController.requireAuth, adminController.deleteNotification);
router.delete('/api/notifications', adminController.requireAuth, adminController.deleteAllNotifications);
router.post('/api/notifications/opened', adminController.requireAuth, adminController.markNotificationOpened);
router.post('/api/notifications/received', adminController.requireAuth, adminController.markNotificationReceived);

// OneSignal analytics route
router.get('/api/onesignal/analytics', adminController.requireAuth, adminController.getOneSignalAnalytics);

module.exports = router;