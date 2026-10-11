const express = require('express');
const adminController = require('../controllers/adminController');
const zodiacController = require('../controllers/zodiacController');
const commandCenterController = require('../controllers/commandCenterController');
const securityController = require('../controllers/securityController');
const aiInsightsController = require('../controllers/aiInsightsController');

const authorize = require('../middleware/authorize'); // Phase-0 Step-3: SHADOW-ONLY (non-enforcing) auth observation
const orgController = require('../controllers/orgController'); // Super-Admin org/access visibility pages (read-only)

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
const reporterHubController = require('../controllers/reporterHubController');
const reporterDuplicateController = require('../controllers/reporterDuplicateController');
const reporterMessageController = require('../controllers/reporterMessageController');

// Update profile image
router.post('/profile/image', adminController.requireAuth, uploadCategoryMedia.single('profileImage'), adminController.updateProfileImage);

// Admin management routes
router.get('/register-editor', adminController.requireAdmin, adminController.renderRegisterEditorPage);
router.post('/register-editor', adminController.requireAdmin, adminController.registerEditor);
router.get('/editors', adminController.requireAuth, adminController.renderEditorsPage);
// Staff Profile Overview (editors list → row chevron). Read-only JSON + exports; admin only.
const staffOverviewController = require('../controllers/staffOverviewController');
router.get('/api/staff/hierarchy.:format(csv|xlsx)', adminController.requireAdmin, staffOverviewController.hierarchyExport);
router.get('/api/staff/:id/overview', adminController.requireAdmin, staffOverviewController.overview);
router.get('/api/staff/:id/team.:format(csv|xlsx)', adminController.requireAdmin, staffOverviewController.teamExport);
router.get('/editors/:id/dashboard', adminController.requireAdmin, authorize.requirePermission('users.impersonate'), adminController.renderImpersonatedDashboard);
router.get('/editors/:id/news-list', adminController.requireAdmin, adminController.renderImpersonatedNewsList);
router.get('/editors/:id/custom-news-count', adminController.requireAdmin, adminController.getImpersonatedNewsCount);
router.post('/editors/multi-report', adminController.requireAdmin, adminController.getMultiEditorReportData);
router.get('/editors/:id/report', adminController.requireAdmin, adminController.getEditorReport);
router.get('/editors/:id/managed-reporters', adminController.requireAdmin, adminController.getEditorManagedReporters);
router.get('/performance-analytics', adminController.requireAuth, adminController.renderPerformanceAnalyticsPage);

// Sub-Editor Work Report (PDF) — Super Admin only, read-only.
const subEditorWorkReportController = require('../controllers/subEditorWorkReportController');
router.get('/sub-editor-work-report', adminController.requireSuperAdmin, subEditorWorkReportController.renderPage);
router.get('/api/sub-editor-work-report/summary', adminController.requireSuperAdmin, subEditorWorkReportController.summaryJson);
router.get('/api/sub-editor-work-report/pdf', adminController.requireSuperAdmin, subEditorWorkReportController.downloadPdf);
router.get('/api/sub-editor-work-report/performance.pdf', adminController.requireSuperAdmin, subEditorWorkReportController.performancePdf);
router.put('/editors/:id', adminController.requireAuth, authorize.requirePermission('users.edit', { observed: 'auth' }), adminController.updateEditor);
router.put('/editors/:id/status', adminController.requireAuth, adminController.toggleEditorStatus);
router.put('/editors/:id/password', adminController.requireAuth, adminController.changeEditorPassword);
// Admin / superadmin → one reporter: personal message (Alerts + push in the reporter app).
router.post('/editors/:id/message', adminController.requireAdmin, reporterMessageController.sendToReporter);
router.delete('/editors/:id', adminController.requireAdmin, authorize.requirePermission('users.delete'), adminController.deleteEditor);

// User management routes
router.get('/users', adminController.requireAuth, adminController.renderUsersListPage);
router.get('/users/:id', adminController.requireAuth, adminController.getUserById); // Add this route

// Reports routes
router.get('/reports', adminController.requireAuth, adminController.renderReportsPage);

// Referrals management routes
router.get('/referrals', adminController.requireAdmin, adminController.renderReferralsPage);
router.put('/referrals/:id/status', adminController.requireAdmin, authorize.requirePermission('payments.review'), adminController.updateReferralStatus);

// Super Admin Command Center (now also hosts the TEHELKA NEXA monitoring section,
// rendered for superadmins by commandCenterController — one unified Command Center).
router.get('/command-center', adminController.requireAdmin, commandCenterController.renderCommandCenter);
router.get('/api/command-center', adminController.requireAdmin, commandCenterController.getCommandCenterData);

// TEHELKA NEXA — manual/test trigger for the Pending News Triage SHADOW workflow.
// Superadmin only. Read-only w.r.t. news; creates only shadow NexaTask records;
// inert while NEXA is disabled. No automatic scheduling.
const nexaTriageController = require('../controllers/nexaTriageController');
router.post('/api/nexa/triage/run', adminController.requireSuperAdmin, nexaTriageController.runTriage);
// Bounded drain of NOT-YET-ANALYSED pending news (call repeatedly). Superadmin.
router.post('/api/nexa/triage/process', adminController.requireSuperAdmin, nexaTriageController.processPending);

// TEHELKA NEXA — admin-initiated WhatsApp verification assistant (read-only data +
// audit-only initiate). Superadmin only. No News/workflow change.
const nexaVerifyController = require('../controllers/nexaVerifyController');
router.get('/api/nexa/verify/:newsId', adminController.requireSuperAdmin, nexaVerifyController.getVerifyData);
router.get('/api/nexa/verify/:newsId/summary', adminController.requireSuperAdmin, nexaVerifyController.renderSummaryPage);
router.get('/api/nexa/verify/:newsId/image', adminController.requireSuperAdmin, nexaVerifyController.streamNewsImage);
router.post('/api/nexa/verify/:newsId/initiate', adminController.requireSuperAdmin, nexaVerifyController.initiateVerify);

// TEHELKA NEXA — read-only pending-news list (complete current queue, paginated,
// old→new). Display only: no News/workflow change, no triage triggered. Superadmin.
const nexaPendingController = require('../controllers/nexaPendingController');
router.get('/api/nexa/pending-news', adminController.requireSuperAdmin, nexaPendingController.listPending);

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
// District-scoped village/locality autocomplete (district derived from the
// authenticated reporter; reuses the existing geolocations data). Read-only.
const reporterVillageController = require('../controllers/reporterVillageController');
router.get('/api/reporter/villages', adminController.requireAuth, reporterVillageController.searchVillages);
// Step 2/4 — status/coverage of the selected place (must be inside the
// reporter's own district; reuses coverage-map counts). Read-only.
const reporterLocationStatusController = require('../controllers/reporterLocationStatusController');
router.get('/api/reporter/location-status', adminController.requireAuth, reporterLocationStatusController.locationStatus);
// Step 3/4 — news categories the reporter may file under. Reuses the existing
// Category collection + its `showToReporters` flag (admin-managed). Read-only.
const reporterCategoryController = require('../controllers/reporterCategoryController');
router.get('/api/reporter/categories', adminController.requireAuth, reporterCategoryController.listCategories);
// Reporter app pre-submit "similar news" check (Confirm step). Read-only; reuses the
// same duplicate engine as the pending-news page. Never blocks filing (timeout → unchecked).
router.post('/api/reporter/news/similar', adminController.requireAuth, reporterDuplicateController.similarNews);
// Reporter app: personal messages from the desk (own messages only; server-side scope).
router.get('/api/reporter/messages', adminController.requireAuth, reporterMessageController.listMine);
router.post('/api/reporter/messages/read', adminController.requireAuth, reporterMessageController.markRead);

// Cloudflare R2 Usage route
router.get('/r2-usage', adminController.requireAuth, adminController.renderR2UsagePage);

// Pending News Review route (for editors to approve/reject news)
router.get('/pending-news', adminController.requireAuth, adminController.renderPendingNewsPage);
router.get('/my-ai-queue', adminController.requireAuth, adminController.renderMyAiQueuePage);
router.delete('/api/my-ai-queue/:id', adminController.requireAuth, adminController.deleteMyAiQueueNews);
router.get('/api/pending-news/duplicate-check', adminController.requireAuth, adminController.getPendingNewsDuplicateCheck);
router.get('/api/reporter-reliability', adminController.requireSuperAdmin, adminController.getReporterReliability);
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
router.post('/api/polls/upload-image', adminController.requireAuth, uploadAdMedia.single('image'), adminController.uploadPollImage);
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

// District assignment approval workflow: state in-charge proposes → admin approves.
const districtAssignmentController = require('../controllers/districtAssignmentController');
// State in-charge (any logged-in admin; scope enforced in controller)
router.post('/api/district-assignments/request', adminController.requireAuth, districtAssignmentController.createRequest);
router.get('/api/district-assignments/mine', adminController.requireAuth, districtAssignmentController.myRequests);
router.get('/my-district-assignments', adminController.requireAuth, districtAssignmentController.renderMyPage);
router.get('/api/district-assignments/scope', adminController.requireAuth, districtAssignmentController.myScope);
// Admin only
router.get('/district-assignment-approvals', adminController.requireAdmin, districtAssignmentController.renderApprovalsPage);
router.get('/api/district-assignments/pending', adminController.requireAdmin, districtAssignmentController.listPending);
router.post('/api/district-assignments/:id/approve', adminController.requireAdmin, districtAssignmentController.approve);
router.post('/api/district-assignments/:id/reject', adminController.requireAdmin, districtAssignmentController.reject);
// Remove (revoke) an already-approved assignment — reporter stops being in-charge of that district.
router.post('/api/district-assignments/:id/revoke', adminController.requireAdmin, districtAssignmentController.revoke);
// Division (admin): split a state's districts among its state in-charges
router.get('/district-division', adminController.requireAdmin, districtAssignmentController.renderDivisionPage);
router.get('/api/district-assignments/division/states', adminController.requireAdmin, districtAssignmentController.divisionStates);
router.get('/api/district-assignments/division', adminController.requireAdmin, districtAssignmentController.divisionData);
router.post('/api/district-assignments/division', adminController.requireAdmin, districtAssignmentController.saveDivision);

// Games page layout (admin uploads image + drags a tappable box over each game).
const gamesLayoutController = require('../controllers/gamesLayoutController');
router.get('/games-layout', adminController.requireAdmin, gamesLayoutController.renderPage);
router.get('/api/games-layout', adminController.requireAdmin, gamesLayoutController.getLayout);
router.put('/api/games-layout', adminController.requireAdmin, gamesLayoutController.saveLayout);

// District In-Charge — month-wise wallet clear (enter mobile → pick months → clear).
const walletClearController = require('../controllers/walletClearController');
router.get('/wallet-clear', adminController.requireAdmin, walletClearController.renderPage);
// Alias: tolerate a doubled /admin prefix (some cached/relative links produce
// /admin/admin/wallet-clear) so the page always opens instead of a 404.
router.get('/admin/wallet-clear', adminController.requireAdmin, walletClearController.renderPage);
router.get('/api/wallet-clear/lookup', adminController.requireAdmin, walletClearController.lookup);
router.post('/api/wallet-clear/apply', adminController.requireAdmin, walletClearController.apply);
router.post('/api/wallet-clear/rollback', adminController.requireAdmin, walletClearController.rollback);

// Late-Approval Earning — Super Admin release queue + accountability (enforced in controller).
const lateEarningController = require('../controllers/lateEarningController');
router.get('/late-earnings', adminController.requireAdmin, lateEarningController.renderQueue);
router.get('/late-earnings/api/pending', adminController.requireAdmin, lateEarningController.listPending);
router.get('/late-earnings/api/reasons', adminController.requireAdmin, lateEarningController.listReasons);
router.post('/late-earnings/api/:id/release', adminController.requireAdmin, authorize.requirePermission('payments.approve'), lateEarningController.release);
router.post('/late-earnings/api/:id/send-back', adminController.requireAdmin, authorize.requirePermission('payments.review'), lateEarningController.sendBack);
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

// Daily Quiz — admin Question Bank (P1). Admin-only.
const quizAdminController = require('../controllers/quizAdminController');
router.get('/quiz/questions', adminController.requireAdmin, quizAdminController.renderQuestions);
router.get('/quiz/placement', adminController.requireAdmin, quizAdminController.renderPlacement);
router.get('/quiz/banner', adminController.requireAdmin, quizAdminController.renderBanner);
router.get('/quiz/api/banner', adminController.requireAdmin, quizAdminController.getBanner);
router.put('/quiz/api/banner', adminController.requireAdmin, quizAdminController.saveBanner);
router.get('/quiz/api/settings', adminController.requireAdmin, quizAdminController.getSettings);
router.put('/quiz/api/settings', adminController.requireAdmin, quizAdminController.updateSettings);
router.put('/quiz/api/settings/feed-position', adminController.requireAdmin, quizAdminController.updateFeedPosition);
router.get('/quiz/api/questions/pool-health', adminController.requireAdmin, quizAdminController.getPoolHealth);
router.get('/quiz/api/questions', adminController.requireAdmin, quizAdminController.listQuestions);
router.post('/quiz/api/questions', adminController.requireAdmin, quizAdminController.createQuestion);
router.put('/quiz/api/questions/:id', adminController.requireAdmin, quizAdminController.updateQuestion);
router.post('/quiz/api/questions/bulk-delete', adminController.requireAdmin, quizAdminController.bulkDeleteQuestions);
router.delete('/quiz/api/questions/:id', adminController.requireAdmin, quizAdminController.deleteQuestion);
router.post('/quiz/api/questions/:id/archive', adminController.requireAdmin, quizAdminController.archiveQuestion);
router.get('/quiz/api/questions/:id/stats', adminController.requireAdmin, quizAdminController.questionStats);
// Excel import (admin-only; in-memory, 5MB cap)
const quizUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
router.get('/quiz/api/questions/template', adminController.requireAdmin, quizAdminController.downloadTemplate);
router.post('/quiz/api/questions/import', adminController.requireAdmin, quizUpload.single('file'), quizAdminController.importQuestions);
// Quiz weekly dashboard + winner selection (P3)
router.get('/quiz/dashboard', adminController.requireAdmin, quizAdminController.renderDashboard);
router.get('/quiz/api/week', adminController.requireAdmin, quizAdminController.weekStats);
router.get('/quiz/api/analytics', adminController.requireAdmin, quizAdminController.getAnalytics);
// Dynamic quiz rules (info sections shown in the app)
router.get('/quiz/rules', adminController.requireAdmin, quizAdminController.renderRules);
router.get('/quiz/api/rules', adminController.requireAdmin, quizAdminController.getRules);
router.put('/quiz/api/rules', adminController.requireAdmin, quizAdminController.updateRules);
router.get('/quiz/api/participants', adminController.requireAdmin, quizAdminController.listParticipants);
router.get('/quiz/api/participants/export', adminController.requireAdmin, quizAdminController.exportParticipants);
router.get('/quiz/api/winners/export', adminController.requireAdmin, quizAdminController.exportWinners);
router.get('/quiz/api/week/eligible', adminController.requireAdmin, quizAdminController.eligibleList);
router.get('/quiz/api/week/eligible/pdf', adminController.requireAdmin, quizAdminController.eligiblePdf);
router.get('/quiz/api/week/collusion', adminController.requireAdmin, quizAdminController.getCollusionReport);
router.post('/quiz/api/week/winners', adminController.requireAdmin, quizAdminController.selectWinners);
router.get('/quiz/api/winners', adminController.requireAdmin, quizAdminController.winnerHistory);
router.post('/quiz/api/maintenance', adminController.requireAdmin, quizAdminController.maintenance);
// Manual / custom winners (publish a winners list even with fewer than 10 eligible)
const quizManualWinnersController = require('../controllers/quizManualWinnersController');
router.get('/quiz/manual-winners', adminController.requireAdmin, quizManualWinnersController.renderPage);
router.get('/quiz/api/manual-winners', adminController.requireAdmin, quizManualWinnersController.getData);
router.post('/quiz/api/manual-winners', adminController.requireAdmin, quizManualWinnersController.save);
router.delete('/quiz/api/manual-winners', adminController.requireAdmin, quizManualWinnersController.clear);
router.get('/quiz/api/manual-winners/pdf', adminController.requireAdmin, quizManualWinnersController.winnersPdf);
// Quiz Test Mode (admin day simulation — isolated test data, never affects live users)
router.get('/quiz/api/resolve-user', adminController.requireAdmin, quizAdminController.resolveTestUser);
router.get('/quiz/api/test-mode/active', adminController.requireAdmin, quizAdminController.activeTestMode);
router.get('/quiz/api/test-mode', adminController.requireAdmin, quizAdminController.getTestMode);
router.post('/quiz/api/test-mode', adminController.requireAdmin, quizAdminController.setTestMode);
router.post('/quiz/api/test-winners', adminController.requireAdmin, quizAdminController.createTestWinners);
router.delete('/quiz/api/test-winners', adminController.requireAdmin, quizAdminController.clearTestWinners);

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
router.get('/api/reporter/district-overview', adminController.requireAuth, adminController.getReporterDistrictOverview);
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
router.put('/api/wallet-settings', adminController.requireAdmin, authorize.requirePermission('settings.finance'), adminController.updateWalletSettings);
router.get('/api/wallet/withdrawals', adminController.requireAdmin, adminController.listWalletWithdrawals);
router.get('/api/wallet/withdrawals/user/:adminId', adminController.requireAdmin, adminController.getWithdrawalUserDetail);
router.post('/api/wallet/withdrawals/:id/process', adminController.requireAdmin, authorize.requirePermission('payments.process'), adminController.processWalletWithdrawal);

// Phase 1 — Withdrawals queue, transactions ledger, audit logs
router.get('/withdrawals-queue', adminController.requireAdmin, adminController.renderWithdrawalsQueuePage);
router.get('/wallet-transactions', adminController.requireAdmin, adminController.renderWalletTransactionsPage);
router.get('/api/wallet-transactions', adminController.requireAdmin, adminController.listWalletTransactionsAdmin);
router.get('/api/wallet-transactions/export', adminController.requireAdmin, authorize.requirePermission('payments.export'), adminController.exportWalletTransactionsCsv);
router.get('/api/wallet-transactions/export-pdf', adminController.requireAdmin, authorize.requirePermission('payments.export'), adminController.exportWalletTransactionsPdf);
router.post('/api/wallet-adjustment', adminController.requireAdmin, authorize.requirePermission('payments.adjust'), adminController.createWalletAdjustment);
router.get('/api/wallet-reporters/search', adminController.requireAdmin, adminController.searchWalletReporters);
router.get('/audit-logs', adminController.requireAdmin, adminController.renderAuditLogsPage);

// ── Organization & Access (Super Admin only, READ-ONLY visibility) ──────────
router.get('/organization', adminController.requireSuperAdmin, orgController.renderOrganizationPage);
router.get('/authorization', adminController.requireSuperAdmin, orgController.renderAuthorizationPage);
router.get('/shadow-mode', adminController.requireSuperAdmin, orgController.renderShadowModePage);
router.get('/api/audit-logs', adminController.requireAdmin, authorize.requirePermission('audit.view'), adminController.listAuditLogs);

// Phase 2 — Reporter earnings analytics
router.get('/reporter-analytics', adminController.requireAdmin, adminController.renderReporterAnalyticsPage);
router.get('/category-insights', adminController.requireAdmin, adminController.renderCategoryInsightsPage);

// Database Backups (Super Admin) — list / run / download / delete (email-OTP)
const dbBackupController = require('../controllers/dbBackupController');
router.get('/db-backups', adminController.requireAdmin, dbBackupController.renderPage);
router.post('/db-backups/run', adminController.requireAdmin, dbBackupController.runNow);
router.get('/db-backups/download', adminController.requireAdmin, dbBackupController.download);
router.post('/db-backups/delete/send-otp', adminController.requireAdmin, dbBackupController.sendDeleteOtp);
router.post('/db-backups/delete/confirm', adminController.requireAdmin, dbBackupController.confirmDelete);
router.get('/api/reporter-analytics/overview', adminController.requireAdmin, adminController.getReporterAnalyticsOverview);
router.get('/api/reporter-analytics/leaderboard', adminController.requireAdmin, adminController.getReporterLeaderboard);
router.get('/api/reporter-analytics/locations', adminController.requireAdmin, adminController.getReporterLocationAnalytics);
router.get('/api/reporter-analytics/reporter/:id', adminController.requireAdmin, adminController.getReporterAnalyticsDetail);

// Phase 3 — Fraud alerts & account controls
router.get('/fraud-alerts', adminController.requireAdmin, adminController.renderFraudAlertsPage);
router.get('/api/fraud-alerts', adminController.requireAdmin, adminController.getFraudAlerts);
router.get('/api/fraud/reporter/:id/location-posts', adminController.requireAdmin, adminController.getFraudLocationPosts);
router.post('/api/fraud/reporter/:id/wallet-freeze', adminController.requireAdmin, authorize.requirePermission('wallet.freeze'), adminController.setWalletFreeze);
router.post('/api/fraud/reporter/:id/suspend', adminController.requireAdmin, adminController.setReporterSuspension);

// Reporter Security (Super Admin): switches, linked-account groups, held withdrawals, app logins
const reporterSecurityController = require('../controllers/reporterSecurityController');
router.get('/reporter-security', adminController.requireSuperAdmin, reporterSecurityController.renderPage);
router.get('/api/reporter-security/overview', adminController.requireSuperAdmin, reporterSecurityController.getOverview);
router.post('/api/reporter-security/settings', adminController.requireSuperAdmin, reporterSecurityController.updateSettings);
router.post('/api/reporter-security/withdrawals/:id/clear-hold', adminController.requireSuperAdmin, reporterSecurityController.clearHold);

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

// Reporter Hub — the MAIN app's "+" screen (per language, feature-flag `enabled` default OFF)
router.get('/reporter-hub', adminController.requireAdmin, reporterHubController.renderPage);
router.get('/api/reporter-hub', adminController.requireAdmin, reporterHubController.getAdmin);
router.put('/api/reporter-hub', adminController.requireAdmin, reporterHubController.updateAdmin);
router.post(
  '/api/reporter-hub/upload-image',
  adminController.requireAdmin,
  uploadAdMedia.single('image'),
  reporterHubController.uploadImage
);

// Reporter Advertise page — the in-app "Earn extra income" landing page opened
// from the hub's advertise card (per language, feature-flag `enabled` default OFF).
const reporterAdvertiseController = require('../controllers/reporterAdvertiseController');
router.get('/reporter-advertise', adminController.requireAdmin, reporterAdvertiseController.renderPage);
router.get('/api/reporter-advertise', adminController.requireAdmin, reporterAdvertiseController.getAdmin);
router.put('/api/reporter-advertise', adminController.requireAdmin, reporterAdvertiseController.updateAdmin);
router.post(
  '/api/reporter-advertise/upload-image',
  adminController.requireAdmin,
  uploadAdMedia.single('image'),
  reporterAdvertiseController.uploadImage
);

// Special deck — the main app's LEFT-swipe "special world" (curated news / quiz /
// train / ads per language; per-language `enabled` default OFF).
const specialDeckController = require('../controllers/specialDeckController');
router.get('/special-deck', adminController.requireAdmin, specialDeckController.renderPage);
router.get('/api/special-deck', adminController.requireAdmin, specialDeckController.getAdmin);
router.put('/api/special-deck', adminController.requireAdmin, specialDeckController.updateAdmin);
router.get('/api/special-deck/search-news', adminController.requireAdmin, specialDeckController.searchNews);
router.get('/api/special-deck/ads', adminController.requireAdmin, specialDeckController.listAds);
router.post(
  '/api/special-deck/upload-image',
  adminController.requireAdmin,
  uploadAdMedia.single('image'),
  specialDeckController.uploadImage
);

// Train Promo Banner — the single banner under "Search history" on the app's
// "Where is my train" page (image + clickable hotspots; `enabled` default OFF).
const trainPromoBannerController = require('../controllers/trainPromoBannerController');
router.get('/train-promo-banner', adminController.requireAdmin, trainPromoBannerController.renderPage);
router.get('/api/train-promo-banner', adminController.requireAdmin, trainPromoBannerController.getAdmin);
router.put('/api/train-promo-banner', adminController.requireAdmin, trainPromoBannerController.updateAdmin);
router.post(
  '/api/train-promo-banner/upload-image',
  adminController.requireAdmin,
  uploadAdMedia.single('image'),
  trainPromoBannerController.uploadImage
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

// ── Reporter "Join as a Reporter" popup — admin image-hotspot editor ──
const reporterJoinPopupController = require('../controllers/reporterJoinPopupController');
router.get('/reporter-join-popup', adminController.requireAdmin, reporterJoinPopupController.renderPage);
router.get('/api/reporter-join-popup', adminController.requireAdmin, reporterJoinPopupController.getConfig);
router.post('/api/reporter-join-popup', adminController.requireAdmin, reporterJoinPopupController.saveConfig);
router.post('/api/reporter-join-popup/upload-image', adminController.requireAdmin, uploadAdMedia.single('image'), reporterJoinPopupController.uploadImage);
router.post('/api/reporter/popups/:id/ack', adminController.requireAuth, adminController.ackReporterPopup);

// Reporter guidelines (per language + design)
router.get('/reporter-guidelines', adminController.requireAdmin, adminController.renderReporterGuidelinesPage);
router.get('/api/reporter-guidelines', adminController.requireAdmin, adminController.getReporterGuidelinesAdmin);
router.put('/api/reporter-guidelines', adminController.requireAdmin, adminController.updateReporterGuidelinesAdmin);
router.get('/api/reporter/guidelines', adminController.requireAuth, adminController.getReporterGuidelines);

// Reporter earning page (extra income — per language + design)
router.get('/reporter-earning', adminController.requireAdmin, adminController.renderReporterEarningPage);
router.get('/api/reporter-earning', adminController.requireAdmin, adminController.getReporterEarningAdmin);
router.put('/api/reporter-earning', adminController.requireAdmin, authorize.requirePermission('payments.config'), adminController.updateReporterEarningAdmin);
router.post(
  '/api/reporter-earning/upload-image',
  adminController.requireAdmin,
  uploadAdMedia.single('image'),
  adminController.uploadReporterEarningImage
);
router.get('/api/reporter/earning', adminController.requireAuth, adminController.getReporterEarning);

// In-App Popup (Firebase/OneSignal-style) — admin management
const inAppPopupController = require('../controllers/inAppPopupController');
router.get('/in-app-popup', adminController.requireAdmin, inAppPopupController.renderPage);
router.post('/api/in-app-popup/upload-image', adminController.requireAdmin, uploadAdMedia.single('image'), inAppPopupController.uploadImage);
router.get('/api/in-app-popup', adminController.requireAdmin, inAppPopupController.getAll);
router.post('/api/in-app-popup', adminController.requireAdmin, inAppPopupController.create);
router.put('/api/in-app-popup/:id', adminController.requireAdmin, inAppPopupController.update);
router.patch('/api/in-app-popup/:id/toggle', adminController.requireAdmin, inAppPopupController.toggleActive);

// Notification Studio — 18 notification designs, targeting, preview, test send.
// Additive: the older /admin/notifications page above still works unchanged.
const notificationStudioController = require('../controllers/notificationStudioController');
router.get('/notification-studio', adminController.requireAdmin, notificationStudioController.renderPage);
router.get('/api/notification-studio/options', adminController.requireAdmin, notificationStudioController.getOptions);
router.get('/api/notification-studio/districts', adminController.requireAdmin, notificationStudioController.getDistricts);
router.get('/api/notification-studio/people', adminController.requireAdmin, notificationStudioController.searchPeople);
router.get('/api/notification-studio/news', adminController.requireAdmin, notificationStudioController.searchNews);
router.post('/api/notification-studio/preview', adminController.requireAdmin, notificationStudioController.preview);
router.post('/api/notification-studio/send', adminController.requireAdmin, notificationStudioController.send);
router.get('/api/notification-studio/history', adminController.requireAdmin, notificationStudioController.history);
router.get('/api/notification-studio/report/:id', adminController.requireAdmin, notificationStudioController.deliveryReport);

// "Tehelka Incharge" app (separate APK for State In-Charges). Bearer auth via
// requireAuth; the controller itself refuses anyone who is not an In-Charge or
// admin, and scopes the queue with the dashboard's own pending filter.
const inchargeAppController = require('../controllers/inchargeAppController');
router.get('/api/incharge/me', adminController.requireAuth, inchargeAppController.me);
router.get('/api/incharge/pending', adminController.requireAuth, inchargeAppController.pending);
router.get('/api/incharge/lists', adminController.requireAuth, inchargeAppController.lists);
router.get('/api/incharge/coverage', adminController.requireAuth, inchargeAppController.coverage);
router.get('/api/incharge/reporter/:id', adminController.requireAuth, inchargeAppController.reporterDetail);
router.get('/api/incharge/my-work', adminController.requireAuth, inchargeAppController.myWork);
router.get('/api/incharge/analytics', adminController.requireAuth, inchargeAppController.analytics);
router.get('/api/incharge/news-list', adminController.requireAuth, inchargeAppController.newsList);
router.get('/api/incharge/rejected', adminController.requireAuth, inchargeAppController.rejected);
router.get('/api/incharge/plagiarism', adminController.requireAuth, inchargeAppController.plagiarism);
router.get('/api/incharge/news-form', adminController.requireAuth, inchargeAppController.newsForm);
router.get('/api/incharge/news/:id', adminController.requireAuth, inchargeAppController.newsDetail);
router.get('/api/incharge/news/:id/duplicates', adminController.requireAuth, inchargeAppController.newsDuplicates);
router.get('/api/incharge/news/:id/versions', adminController.requireAuth, inchargeAppController.newsVersions);
router.post('/api/incharge/heartbeat', adminController.requireAuth, inchargeAppController.heartbeat);
// The desk's live view of the In-Charges (admins only).
router.get('/monitor', adminController.requireAdmin, inchargeAppController.renderMonitorPage);
router.get('/api/incharge/monitor', adminController.requireAdmin, inchargeAppController.monitor);
router.get('/api/incharge/monitor/:id/history', adminController.requireAdmin, inchargeAppController.history);
router.post(
  '/api/notification-studio/upload-image',
  adminController.requireAdmin,
  uploadAdMedia.single('image'),
  notificationStudioController.uploadImage
);

module.exports = router;