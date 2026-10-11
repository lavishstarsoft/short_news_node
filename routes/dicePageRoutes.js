'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/dicePageController');
const { requireAdmin } = require('../controllers/adminController');
const { uploadAdMedia } = require('../middleware/upload');

// Admin/superadmin only (editors, sub-editors, reporters are blocked).
router.get('/admin', requireAdmin, ctrl.renderPage);
// Face images go through the AD pipeline (resize:false → aspect kept, no crop),
// NOT /news/upload-media which force-crops everything to 1080×900.
router.post('/api/upload', requireAdmin, uploadAdMedia.single('media'), ctrl.upload);
router.get('/api/list', requireAdmin, ctrl.list);
router.post('/api', requireAdmin, ctrl.create);
router.put('/api/:id', requireAdmin, ctrl.update);
router.delete('/api/:id', requireAdmin, ctrl.remove);
router.post('/api/:id/toggle', requireAdmin, ctrl.toggle);
router.get('/api/public', ctrl.getPublic); // public — the app polls this (no auth)

module.exports = router;
