const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/staffCategoryController');
const { requireAuth } = require('../controllers/adminController');

// Every route requires a logged-in admin session; admin/superadmin is enforced
// per-handler (mirrors languageRoutes).
router.use(requireAuth);

router.get('/', ctrl.renderPage);
router.get('/api', ctrl.list);
router.post('/api', ctrl.create);
router.put('/api/:id', ctrl.update);

module.exports = router;
