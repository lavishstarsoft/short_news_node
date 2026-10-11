'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/coverageController');
const { requireAdmin } = require('../controllers/adminController');

// Admin/superadmin only (editors, sub-editors, reporters are blocked).
router.get('/admin', requireAdmin, ctrl.renderPage);
router.post('/api', requireAdmin, ctrl.save);
router.get('/api/public', ctrl.getPublic); // public — the app polls this (no auth)

module.exports = router;
