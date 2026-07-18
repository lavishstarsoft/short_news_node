const express = require('express');
const adminController = require('../controllers/adminController');
const zodiacController = require('../controllers/zodiacController');
const commandCenterController = require('../controllers/commandCenterController');
const securityController = require('../controllers/securityController');

const router = express.Router();

// Admin authentication routes
router.get('/login', adminController.renderLoginPage);
router.post('/login', adminController.login);
router.get('/logout', adminController.logout);

// Admin dashboard routes
router.get('/dashboard', adminController.requireAuth, adminController.renderDashboard);
router.get('/api/scoped-analytics', adminController.requireAuth, adminController.getScopedAnalytics);
router.get('/profile', adminController.requireAuth, adminController.renderProfilePage);
router.put('/profile', adminController.requireAuth, adminController.updateProfile);

// Import upload middleware
const { uploadCategoryMedia, uploadAdMedia } = require('../middleware/upload');

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

const reporterPopupController = require('../controllers/reporterPopupController');

// Reporter/Editor API routes (for mobile/Next.js apps)
router.post('/api/reporter/login', adminController.reporterLogin);
router.get('/api/reporter/profile', adminController.requireAuth, adminController.getReporterProfile);

// In-App Popup Notification routes
router.get('/popups', adminController.requireAdmin, reporterPopupController.renderPopupsPage);
router.get('/api/popups', adminController.requireAdmin, reporterPopupController.getPopups);
router.post('/api/popups', adminController.requireAdmin, reporterPopupController.createPopup);
router.put('/api/popups/:id', adminController.requireAdmin, reporterPopupController.updatePopup);
router.delete('/api/popups/:id', adminController.requireAdmin, reporterPopupController.deletePopup);

// Reporter Dashboard Popup APIs
router.get('/api/reporter/active-popup', adminController.requireAuth, reporterPopupController.getActiveReporterPopup);
router.post('/api/reporter/popup/:id/interact', adminController.requireAuth, reporterPopupController.recordPopupInteraction);

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

// Super Admin Security & Fraud Control
router.get('/security', adminController.requireAdmin, securityController.renderSecurityPage);
router.post('/security/block', adminController.requireAdmin, securityController.blockIdentifier);
router.post('/security/clear', adminController.requireAdmin, securityController.clearDeviceLogs);
// Reporter Wallet / Stats API
router.get('/api/reporter/daily-stats', adminController.requireAuth, adminController.getReporterDailyStats);
router.get('/api/reporter/wallet/summary', adminController.requireAuth, adminController.getReporterWalletSummary);
router.get('/api/reporter/wallet/transactions', adminController.requireAuth, adminController.getReporterWalletTransactions);
router.get('/api/reporter/wallet/withdrawals', adminController.requireAuth, adminController.getReporterWithdrawals);
router.post('/api/reporter/wallet/withdraw', adminController.requireAuth, adminController.createReporterWithdrawal);
router.post('/api/reporter/wallet/withdrawals/:id/cancel', adminController.requireAuth, adminController.cancelReporterWithdrawal);
router.get('/api/reporter/wallet/payout-methods', adminController.requireAuth, adminController.getReporterPayoutMethods);
router.post('/api/reporter/wallet/payout-methods', adminController.requireAuth, adminController.addReporterPayoutMethod);
router.post('/api/reporter/wallet/payout-methods/:id/default', adminController.requireAuth, adminController.setDefaultReporterPayoutMethod);
router.delete('/api/reporter/wallet/payout-methods/:id', adminController.requireAuth, adminController.deleteReporterPayoutMethod);
router.get('/reporter/wallet', adminController.requireAuth, adminController.renderReporterWalletPage);
router.get('/wallet-settings', adminController.requireAdmin, adminController.renderWalletSettingsPage);
router.get('/api/wallet-settings', adminController.requireAdmin, adminController.getWalletSettings);
router.put('/api/wallet-settings', adminController.requireAdmin, adminController.updateWalletSettings);
router.get('/api/wallet/withdrawals', adminController.requireAdmin, adminController.listWalletWithdrawals);
router.post('/api/wallet/withdrawals/:id/process', adminController.requireAdmin, adminController.processWalletWithdrawal);

// Phase 1 — Withdrawals queue, transactions ledger, audit logs
router.get('/withdrawals-queue', adminController.requireAdmin, adminController.renderWithdrawalsQueuePage);
router.get('/wallet-transactions', adminController.requireAdmin, adminController.renderWalletTransactionsPage);
router.get('/api/wallet-transactions', adminController.requireAdmin, adminController.listWalletTransactionsAdmin);
router.get('/api/wallet-transactions/export', adminController.requireAdmin, adminController.exportWalletTransactionsCsv);
router.post('/api/wallet-adjustment', adminController.requireAdmin, adminController.createWalletAdjustment);
router.get('/api/wallet-reporters/search', adminController.requireAdmin, adminController.searchWalletReporters);
router.get('/audit-logs', adminController.requireAdmin, adminController.renderAuditLogsPage);
router.get('/api/audit-logs', adminController.requireAdmin, adminController.listAuditLogs);

// Phase 2 — Reporter earnings analytics
router.get('/reporter-analytics', adminController.requireAdmin, adminController.renderReporterAnalyticsPage);
router.get('/api/reporter-analytics/overview', adminController.requireAdmin, adminController.getReporterAnalyticsOverview);
router.get('/api/reporter-analytics/leaderboard', adminController.requireAdmin, adminController.getReporterLeaderboard);
router.get('/api/reporter-analytics/locations', adminController.requireAdmin, adminController.getReporterLocationAnalytics);
router.get('/api/reporter-analytics/reporter/:id', adminController.requireAdmin, adminController.getReporterAnalyticsDetail);

// Phase 3 — Fraud alerts & account controls
router.get('/fraud-alerts', adminController.requireAdmin, adminController.renderFraudAlertsPage);
router.get('/api/fraud-alerts', adminController.requireAdmin, adminController.getFraudAlerts);
router.get('/api/fraud/reporter/:id/location-posts', adminController.requireAdmin, adminController.getFraudLocationPosts);
router.post('/api/fraud/reporter/:id/wallet-freeze', adminController.requireAdmin, adminController.setWalletFreeze);
router.post('/api/fraud/reporter/:id/suspend', adminController.requireAdmin, adminController.setReporterSuspension);

// Phase 4 — Engagement (reporter app) + monthly reports (admin)
router.get('/api/reporter/engagement', adminController.requireAuth, adminController.getReporterEngagement);
router.get('/monthly-report', adminController.requireAdmin, adminController.renderMonthlyReportPage);
router.get('/news-map', adminController.requireAdmin, adminController.renderNewsMapPage);
router.get('/api/news-map', adminController.requireAdmin, adminController.getNewsMapData);
router.get('/api/reports/monthly', adminController.requireAdmin, adminController.getMonthlyReport);

// Reporter home page banner (per admin language)
router.get('/reporter-home-content', adminController.requireAdmin, adminController.renderReporterHomeContentPage);
router.get('/api/reporter-home-content', adminController.requireAdmin, adminController.getReporterHomeContentAdmin);
router.put('/api/reporter-home-content', adminController.requireAdmin, adminController.updateReporterHomeContentAdmin);
router.post(
  '/api/reporter-home-content/upload-image',
  adminController.requireAdmin,
  uploadAdMedia.single('image'),
  adminController.uploadReporterHomeCardImage
);
router.get('/api/reporter/home-banner', adminController.requireAuth, adminController.getReporterHomeBanner);

// Reporter guidelines (per language + design)
router.get('/reporter-guidelines', adminController.requireAdmin, adminController.renderReporterGuidelinesPage);
router.get('/api/reporter-guidelines', adminController.requireAdmin, adminController.getReporterGuidelinesAdmin);
router.put('/api/reporter-guidelines', adminController.requireAdmin, adminController.updateReporterGuidelinesAdmin);
router.get('/api/reporter/guidelines', adminController.requireAuth, adminController.getReporterGuidelines);

// Reporter earning page (extra income — per language + design)
router.get('/reporter-earning', adminController.requireAdmin, adminController.renderReporterEarningPage);
router.get('/api/reporter-earning', adminController.requireAdmin, adminController.getReporterEarningAdmin);
router.put('/api/reporter-earning', adminController.requireAdmin, adminController.updateReporterEarningAdmin);
router.post(
  '/api/reporter-earning/upload-image',
  adminController.requireAdmin,
  uploadAdMedia.single('image'),
  adminController.uploadReporterEarningImage
);
router.get('/api/reporter/earning', adminController.requireAuth, adminController.getReporterEarning);

module.exports = router;