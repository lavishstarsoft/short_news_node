const express = require('express');
const adminController = require('../controllers/adminController');
const zodiacController = require('../controllers/zodiacController');
const commandCenterController = require('../controllers/commandCenterController');

const router = express.Router();

// Admin authentication routes
router.get('/login', adminController.renderLoginPage);
router.post('/login', adminController.login);
router.get('/logout', adminController.logout);

// Admin dashboard routes
router.get('/dashboard', adminController.requireAuth, adminController.renderDashboard);
router.get('/profile', adminController.requireAuth, adminController.renderProfilePage);
router.put('/profile', adminController.requireAuth, adminController.updateProfile);

// Import upload middleware
const { uploadCategoryMedia } = require('../middleware/upload');

// Update profile image
router.post('/profile/image', adminController.requireAuth, uploadCategoryMedia.single('profileImage'), adminController.updateProfileImage);

// Admin management routes
router.get('/register-editor', adminController.requireAdmin, adminController.renderRegisterEditorPage);
router.post('/register-editor', adminController.requireAdmin, adminController.registerEditor);
router.get('/editors', adminController.requireAuth, adminController.renderEditorsPage);
router.get('/editors/:id/dashboard', adminController.requireAdmin, adminController.renderImpersonatedDashboard);
router.get('/editors/:id/news-list', adminController.requireAdmin, adminController.renderImpersonatedNewsList);
router.get('/editors/:id/custom-news-count', adminController.requireAdmin, adminController.getImpersonatedNewsCount);
router.post('/editors/multi-report', adminController.requireAdmin, adminController.getMultiEditorReportData);
router.get('/performance-analytics', adminController.requireAuth, adminController.renderPerformanceAnalyticsPage);
router.put('/editors/:id', adminController.requireAuth, adminController.updateEditor);
router.put('/editors/:id/status', adminController.requireAuth, adminController.toggleEditorStatus);
router.put('/editors/:id/password', adminController.requireAuth, adminController.changeEditorPassword);
router.delete('/editors/:id', adminController.requireAdmin, adminController.deleteEditor);

// User management routes
router.get('/users', adminController.requireAuth, adminController.renderUsersListPage);
router.get('/users/:id', adminController.requireAuth, adminController.getUserById); // Add this route

// Reports routes
router.get('/reports', adminController.requireAuth, adminController.renderReportsPage);

// Referrals management routes
router.get('/referrals', adminController.requireAdmin, adminController.renderReferralsPage);
router.put('/referrals/:id/status', adminController.requireAdmin, adminController.updateReferralStatus);

// Super Admin Command Center
router.get('/command-center', adminController.requireAdmin, commandCenterController.renderCommandCenter);
router.get('/api/command-center', adminController.requireAdmin, commandCenterController.getCommandCenterData);

// Notification routes
router.get('/notifications', adminController.requireAuth, adminController.renderNotificationsPage);
router.get('/onesignal-analytics', adminController.requireAdmin, adminController.renderOneSignalAnalyticsPage);
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

// Editor stats by date range
router.get('/api/editor-range-stats', adminController.requireAuth, adminController.getEditorRangeStats);

// Reporter/Editor API routes (for mobile/Next.js apps)
router.post('/api/reporter/login', adminController.reporterLogin);
router.get('/api/reporter/profile', adminController.requireAuth, adminController.getReporterProfile);

// Cloudflare R2 Usage route
router.get('/r2-usage', adminController.requireAuth, adminController.renderR2UsagePage);

// Pending News Review route (for editors to approve/reject news)
router.get('/pending-news', adminController.requireAuth, adminController.renderPendingNewsPage);
router.get('/api/pending-news/duplicate-check', adminController.requireAuth, adminController.getPendingNewsDuplicateCheck);
router.get('/api/pending-news/:id/duplicate-matches', adminController.requireAuth, adminController.getPendingNewsDuplicateMatches);
router.put('/api/news/:id/update-pending', adminController.requireAuth, adminController.updatePendingNews);
router.post('/api/news/:id/approve', adminController.requireAuth, adminController.approveNews);
router.post('/api/news/:id/reject', adminController.requireAuth, adminController.rejectNews);

// Plagiarism & Duplicate Detection routes
router.post('/api/check-duplicate', adminController.requireAuth, adminController.checkDuplicateArticles);
router.get('/plagiarism-report', adminController.requireAuth, adminController.renderPlagiarismReportPage);
router.get('/api/duplicate-details/:id', adminController.requireAuth, adminController.getDuplicateDetails);

// Rejected News route
router.get('/rejected-news', adminController.requireAuth, adminController.renderRejectedNewsPage);
router.delete('/api/rejected-news', adminController.requireAuth, adminController.deleteAllRejectedNews);
router.delete('/api/rejected-news/:id', adminController.requireAuth, adminController.deleteRejectedNewsById);

// Polls routes
router.get('/polls', adminController.requireAuth, adminController.renderPollsPage);
router.post('/api/polls', adminController.requireAuth, adminController.createPollRest);
router.delete('/api/polls/:id', adminController.requireAuth, adminController.deletePollRest);
router.put('/api/polls/:id/status', adminController.requireAuth, adminController.updatePollStatusRest);
router.put('/api/polls/:id', adminController.requireAuth, adminController.updatePollRest);

// Reporter Applications routes
router.put('/api/reporter-applications/:id', adminController.requireAuth, adminController.updateReporterApplication);

// Users route
router.delete('/api/users/:id', adminController.requireAuth, adminController.deleteUserById);

// Zodiac Calendar route
router.get('/zodiac', adminController.requireAuth, adminController.requireSidebarMenu('zodiac'), zodiacController.renderZodiacPage);
router.post('/api/zodiac', adminController.requireAuth, adminController.requireSidebarMenu('zodiac'), zodiacController.saveZodiac);

module.exports = router;