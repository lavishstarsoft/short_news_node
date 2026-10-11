'use strict';

const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/threeDAdController');
const { requireAdmin } = require('../controllers/adminController');
const multer = require('multer');
const lottieUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

// Admin UI + CRUD (auth-gated). Mounted at /3d-ads — a brand-new, isolated
// prefix, so nothing in the existing dashboard or ad system is touched.
router.get('/admin', requireAdmin, ctrl.renderPage);
router.get('/api/list', requireAdmin, ctrl.list);
router.post('/api', requireAdmin, ctrl.create);
router.put('/api/:id', requireAdmin, ctrl.update);
router.delete('/api/:id', requireAdmin, ctrl.remove);
router.post('/api/:id/toggle', requireAdmin, ctrl.toggle);
router.post('/api/emboss', requireAdmin, ctrl.emboss); // image → real 3D .glb
router.post('/api/upload-lottie', requireAdmin, lottieUpload.single('file'), ctrl.uploadLottie); // mascot Lottie .json

// Public — the app polls this (no auth; empty list = nothing to show).
router.get('/api/public', ctrl.getPublic);

module.exports = router;
