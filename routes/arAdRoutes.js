'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/arAdController');
const { requireAdmin } = require('../controllers/adminController');

// Admin UI + CRUD (auth-gated). Mounted at /ar-ads — a brand-new, isolated
// prefix, so nothing in the existing dashboard or ad system is touched.
router.get('/admin', requireAdmin, ctrl.renderPage);
router.get('/api/list', requireAdmin, ctrl.list);
router.post('/api', requireAdmin, ctrl.create);
router.put('/api/:id', requireAdmin, ctrl.update);
router.delete('/api/:id', requireAdmin, ctrl.remove);
router.post('/api/:id/toggle', requireAdmin, ctrl.toggle);

// Public — the app polls this (no auth; empty list = nothing to show).
router.get('/api/public', ctrl.getPublic);
// The app increments impression / AR-open / CTA-tap counters here.
router.post('/api/track', ctrl.track);
// News-in-AR enable/disable (admin page + API) + public config for the app.
router.get('/news-ar', requireAdmin, ctrl.newsArPage);
router.get('/news-ar/api', requireAdmin, ctrl.newsArGet);
router.post('/news-ar/api', requireAdmin, ctrl.newsArSave);
router.get('/news-ar/public', ctrl.newsArPublic);

// News-in-AR: any news image → a poster .glb (cached) for Scene Viewer.
router.get('/news-poster', ctrl.newsPoster);
// News-in-AR from an uploaded card image (public). Field name: 'image'.
const multer = require('multer');
const arUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post('/news-poster-upload', arUpload.single('image'), ctrl.newsPosterUpload);

// Video-in-room (WebXR): a page that plays a video on an AR screen in the user's
// room. The app opens this URL in Chrome with ?src=<videoUrl>&title=<t>.
router.get('/video-viewer', (req, res) => {
  res.sendFile(require('path').join(__dirname, '../views/ar-video.html'));
});

// News-in-AR (WebXR): the captured news card floats in the room; 1 finger moves
// it anywhere (gallery-style), 2 fingers zoom. The app opens ?img=<cardImage>.
router.get('/poster-viewer', (req, res) => {
  res.sendFile(require('path').join(__dirname, '../views/ar-poster.html'));
});

module.exports = router;
