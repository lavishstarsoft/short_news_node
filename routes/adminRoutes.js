const express = require('express');
const adminController = require('../controllers/adminController');
const zodiacController = require('../controllers/zodiacController');
const commandCenterController = require('../controllers/commandCenterController');
const securityController = require('../controllers/securityController');
const aiInsightsController = require('../controllers/aiInsightsController');

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
router.get('/editors/:id/report', adminController.requireAdmin, adminController.getEditorReport);
router.get('/editors/:id/managed-reporters', adminController.requireAdmin, adminController.getEditorManagedReporters);
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
router.get('/my-ai-queue', adminController.requireAuth, adminController.renderMyAiQueuePage);
router.get('/api/pending-news/duplicate-check', adminController.requireAuth, adminController.getPendingNewsDuplicateCheck);
router.get('/api/pending-news/:id/duplicate-matches', adminController.requireAuth, adminController.getPendingNewsDuplicateMatches);
router.put('/api/news/:id/update-pending', adminController.requireAuth, adminController.updatePendingNews);
router.post('/api/news/:id/approve', adminController.requireAuth, adminController.approveNews);
router.post('/api/news/:id/reject', adminController.requireAuth, adminController.rejectNews);
router.post('/api/news/:id/send-back', adminController.requireAuth, adminController.sendBackForEdit);
router.get('/api/news/:id/revision-diff', adminController.requireAuth, adminController.getNewsRevisionDiff);

// Plagiarism & Duplicate Detection routes
router.post('/api/check-duplicate', adminController.requireAuth, adminController.checkDuplicateArticles);
router.get(
  '/api/duplicate-reference/:id',
  adminController.requireAuth,
  adminController.getDuplicateReferenceArticle
);
router.post(
  '/api/duplicate-review/translate',
  adminController.requireAuth,
  adminController.translateForDuplicateReview
);
router.get('/plagiarism-report', adminController.requireAuth, adminController.renderPlagiarismReportPage);
router.get('/api/duplicate-details/:id', adminController.requireAuth, adminController.getDuplicateDetails);

// AI Insights — Duplicate News Insights (Super Admin only; precomputed data)
router.get(
  '/ai-insights/duplicate-news',
  adminController.requireAuth,
  aiInsightsController.renderDuplicateInsightsPage
);
router.get(
  '/ai-insights/duplicate-news/groups/:id',
  adminController.requireAuth,
  aiInsightsController.renderGroupDetailPage
);
router.get(
  '/api/ai-insights/overview',
  adminController.requireAuth,
  aiInsightsController.apiOverview
);
router.get(
  '/api/ai-insights/groups',
  adminController.requireAuth,
  aiInsightsController.apiGroups
);
router.get(
  '/api/ai-insights/groups/:id',
  adminController.requireAuth,
  aiInsightsController.apiGroupDetail
);
router.get(
  '/api/ai-insights/people',
  adminController.requireAuth,
  aiInsightsController.apiPeople
);
router.get(
  '/api/ai-insights/charts',
  adminController.requireAuth,
  aiInsightsController.apiCharts
);
router.post(
  '/api/ai-insights/groups/:id/status',
  adminController.requireAuth,
  aiInsightsController.apiUpdateGroupStatus
);
router.post(
  '/api/ai-insights/scan',
  adminController.requireAuth,
  aiInsightsController.apiTriggerScan
);
router.get(
  '/api/ai-insights/groups/:id/compare',
  adminController.requireAuth,
  aiInsightsController.apiCompare
);
router.post(
  '/api/ai-insights/translate',
  adminController.requireAuth,
  aiInsightsController.apiTranslate
);

// Rejected News route
router.get('/rejected-news', adminController.requireAuth, adminController.renderRejectedNewsPage);
router.delete('/api/rejected-news', adminController.requireAuth, adminController.deleteAllRejectedNews);
router.delete('/api/rejected-news/:id', adminController.requireAuth, adminController.deleteRejectedNewsById);
router.post('/api/rejected-news/:id/revert', adminController.requireAuth, adminController.revertRejectedNews);

// Polls routes
router.get('/polls', adminController.requireAuth, adminController.renderPollsPage);
router.post('/api/polls', adminController.requireAuth, adminController.createPollRest);
router.delete('/api/polls/:id', adminController.requireAuth, adminController.deletePollRest);
router.put('/api/polls/:id/status', adminController.requireAuth, adminController.updatePollStatusRest);
router.put('/api/polls/:id', adminController.requireAuth, adminController.updatePollRest);

// Reporter Applications routes
router.put('/api/reporter-applications/:id', adminController.requireAuth, adminController.updateReporterApplication);

// Deterministic server-side PDF (images fetched + converted + embedded server-side).
router.get('/api/reporter-applications/:id/pdf', adminController.requireAuth, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).send('Invalid id');
    const app = await require('../models/ReporterApplication').findById(req.params.id).lean();
    if (!app) return res.status(404).send('Application not found');
    await require('../utils/reporterApplicationPdf').buildApplicationPdf(app, res);
  } catch (e) {
    console.error('Reporter application PDF error:', e.message);
    if (!res.headersSent) res.status(500).send('PDF generation failed');
  }
});

// Same-origin image proxy for client-side PDF export (avoids cross-origin canvas taint
// that produced blank PDFs). SSRF-guarded to the known media hosts; images only.
router.get('/api/pdf-image-proxy', adminController.requireAuth, async (req, res) => {
  try {
    let u;
    try { u = new URL(String(req.query.url || '')); } catch (_) { return res.status(400).end(); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return res.status(400).end();
    const allowed = (h) => h === 'media.yellowsingam.com' || h.endsWith('.r2.dev') || h.endsWith('.r2.cloudflarestorage.com');
    if (!allowed(u.hostname)) return res.status(403).end();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(u.href, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    if (!r.ok) return res.status(r.status).end();
    // R2 often serves images as application/octet-stream — derive the real image
    // type from the URL extension so the browser treats it as an image.
    const rawCt = r.headers.get('content-type') || '';
    const ext = ((u.pathname.match(/\.(jpe?g|png|webp|gif)$/i) || [, ''])[1] || '').toLowerCase();
    const extMime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext];
    const outCt = /^image\//i.test(rawCt) ? rawCt : extMime;
    if (!outCt) return res.status(415).end(); // genuinely not an image
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', outCt);
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(buf);
  } catch (_) { return res.status(502).end(); }
});

// Users route
router.delete('/api/users/:id', adminController.requireAuth, adminController.deleteUserById);

// Zodiac Calendar route
router.get('/zodiac', adminController.requireAuth, adminController.requireSidebarMenu('zodiac'), zodiacController.renderZodiacPage);
router.post('/api/zodiac', adminController.requireAuth, adminController.requireSidebarMenu('zodiac'), zodiacController.saveZodiac);

// Super Admin Security & Fraud Control
router.get('/security', adminController.requireAdmin, securityController.renderSecurityPage);
router.post('/security/block', adminController.requireAdmin, securityController.blockIdentifier);
router.post('/security/clear', adminController.requireAdmin, securityController.clearDeviceLogs);

// Security Center (Threat Monitor) — Security Alert Engine dashboard (admin only).
const securityAlertController = require('../controllers/securityAlertController');
// State In-Charge Agreement — T&C management (Super Admin enforced in controller) + status.
const agreementTermsController = require('../controllers/agreementTermsController');
router.get('/agreement-terms', adminController.requireAdmin, agreementTermsController.renderTermsAdmin);
router.get('/agreement-terms/api', adminController.requireAdmin, agreementTermsController.list);
router.post('/agreement-terms/api/parse-points', adminController.requireAdmin, agreementTermsController.parsePoints);
router.post('/agreement-terms/api', adminController.requireAdmin, agreementTermsController.createDraft);
router.get('/agreement-terms/api/:id', adminController.requireAdmin, agreementTermsController.getVersion);
router.put('/agreement-terms/api/:id', adminController.requireAdmin, agreementTermsController.updateDraft);
router.post('/agreement-terms/api/:id/publish', adminController.requireAdmin, agreementTermsController.publishDraft);
router.post('/agreement-terms/api/:id/delete', adminController.requireAdmin, agreementTermsController.deletePublishedVersion);

// Individual agreement status deletion via OTP (Super Admin)
router.post('/agreement-terms/api/delete-single/:id/send-otp', adminController.requireAdmin, agreementTermsController.sendDeleteSingleOtp);
router.post('/agreement-terms/api/delete-single/:id/execute', adminController.requireAdmin, agreementTermsController.executeDeleteSingle);

// Agreement/T&C DATA PURGE (Super-Admin only; enforced in controller). Fresh-OTP gated.
router.get('/agreement-terms/api/purge/preview', adminController.requireAdmin, agreementTermsController.previewPurge);
router.post('/agreement-terms/api/purge/send-otp', adminController.requireAdmin, agreementTermsController.sendPurgeOtp);
router.post('/agreement-terms/api/purge/execute', adminController.requireAdmin, agreementTermsController.executePurge);
router.get('/agreement-status', adminController.requireAdmin, agreementTermsController.renderAgreementStatus);
router.get('/agreement-status/:acceptanceId', adminController.requireAdmin, agreementTermsController.renderAcceptanceDetail);

// Reporter District Assignment (Admin/Super-Admin; enforced again in controller).
const reporterDistrictController = require('../controllers/reporterDistrictController');
router.get('/reporter-district-assignment', adminController.requireAdmin, reporterDistrictController.renderPage);
router.get('/reporter-district-assignment/api/districts', adminController.requireAdmin, reporterDistrictController.districts);
router.get('/reporter-district-assignment/api/reporters', adminController.requireAdmin, reporterDistrictController.listReporters);
router.get('/reporter-district-assignment/api/evidence/:id', adminController.requireAdmin, reporterDistrictController.evidence);
router.post('/reporter-district-assignment/api/assign', adminController.requireAdmin, reporterDistrictController.assign);
router.post('/reporter-district-assignment/api/remove', adminController.requireAdmin, reporterDistrictController.remove);

// Late-Approval Earning — Super Admin release queue + accountability (enforced in controller).
const lateEarningController = require('../controllers/lateEarningController');
router.get('/late-earnings', adminController.requireAdmin, lateEarningController.renderQueue);
router.get('/late-earnings/api/pending', adminController.requireAdmin, lateEarningController.listPending);
router.get('/late-earnings/api/reasons', adminController.requireAdmin, lateEarningController.listReasons);
router.post('/late-earnings/api/:id/release', adminController.requireAdmin, lateEarningController.release);
router.post('/late-earnings/api/:id/send-back', adminController.requireAdmin, lateEarningController.sendBack);
router.get('/late-earnings/api/incharge-stats', adminController.requireAdmin, lateEarningController.inchargeStats);
router.get('/api/reporter/late-earnings', adminController.requireAuth, lateEarningController.reporterPending);

// P4 — Emergency daily-limit access override. Role checks live in the controller
// (reporter may only request; State In-Charge/Super Admin grant/revoke, coverage-scoped).
// Coverage Intelligence Map (read-only, coverage-scoped; role checks in controller).
const coverageMapController = require('../controllers/coverageMapController');
router.get('/coverage-map', adminController.requireAuth, coverageMapController.renderPage);
router.get('/coverage-map/api/scope', adminController.requireAuth, coverageMapController.scope);
router.get('/coverage-map/api/state/:state', adminController.requireAuth, coverageMapController.state);
router.get('/coverage-map/api/district/:state/:district', adminController.requireAuth, coverageMapController.district);
router.get('/coverage-map/api/constituency/:state/:district/:constituency', adminController.requireAuth, coverageMapController.constituency);

const accessOverrideController = require('../controllers/accessOverrideController');
router.post('/api/reporter/request-access', adminController.requireAuth, accessOverrideController.requestAccess);
router.get('/reporter-access', adminController.requireAuth, accessOverrideController.renderPage);
router.get('/reporter-access/api/requests', adminController.requireAuth, accessOverrideController.listRequests);
router.post('/reporter-access/api/grant', adminController.requireAuth, accessOverrideController.grant);
router.post('/reporter-access/api/revoke', adminController.requireAuth, accessOverrideController.revoke);

router.get('/security-center', adminController.requireAdmin, securityAlertController.renderSecurityCenter);
router.get('/security-center/data', adminController.requireAdmin, securityAlertController.securityData);
router.post('/security-center/alerts/:id/resolve', adminController.requireAdmin, securityAlertController.resolveAlert);
router.post('/security-center/unblock', adminController.requireAdmin, securityAlertController.unblockIp);
// Reporter Wallet / Stats API
router.get('/api/reporter/daily-stats', adminController.requireAuth, adminController.getReporterDailyStats);
router.get('/api/reporter/period-stats', adminController.requireAuth, adminController.getReporterPeriodStats);
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
router.get('/api/wallet-transactions/export-pdf', adminController.requireAdmin, adminController.exportWalletTransactionsPdf);
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

// In-app popup notifications (superadmin → reporter app)
router.get('/popups', adminController.requireAdmin, adminController.renderReporterPopupsPage);
router.get('/api/popups', adminController.requireAdmin, adminController.getReporterPopupsAdmin);
router.get('/api/popups/target-options', adminController.requireAdmin, adminController.getReporterPopupTargetOptions);
router.post('/api/popups', adminController.requireAdmin, adminController.createReporterPopup);
router.put('/api/popups/:id', adminController.requireAdmin, adminController.updateReporterPopup);
router.delete('/api/popups/:id', adminController.requireAdmin, adminController.deleteReporterPopup);
router.get('/api/popups/:id/history', adminController.requireAdmin, adminController.getReporterPopupHistory);
router.post(
  '/api/popups/upload-image',
  adminController.requireAdmin,
  uploadAdMedia.single('image'),
  adminController.uploadReporterHomeCardImage
);
router.get('/api/reporter/popups', adminController.requireAuth, adminController.getActiveReporterPopups);
router.post('/api/reporter/popups/:id/ack', adminController.requireAuth, adminController.ackReporterPopup);

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