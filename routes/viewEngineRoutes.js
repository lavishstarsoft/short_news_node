const express = require('express');
const router = express.Router();
const viewEngineController = require('../controllers/viewEngineController');

// Super admin middleware
const requireSuperAdmin = (req, res, next) => {
    if (req.admin && req.admin.role === 'superadmin') {
        next();
    } else {
        res.status(403).render('error', { message: 'Unauthorized. Super Admin access only.' });
    }
};

// Apply super admin check to all routes in this module
router.use(requireSuperAdmin);

// Routes
router.get('/dashboard', viewEngineController.renderDashboard);
router.get('/campaigns', viewEngineController.renderCampaigns);
router.get('/status', viewEngineController.renderStatus);
router.get('/settings', viewEngineController.renderSettings);

module.exports = router;
