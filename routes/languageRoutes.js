const express = require('express');
const router = express.Router();
const languageController = require('../controllers/languageController');
const { requireAuth } = require('../controllers/adminController');

router.use(requireAuth);

router.get('/', (req, res) => {
  if (req.admin.role !== 'admin' && req.admin.role !== 'superadmin') {
    return res.status(403).send('Access denied. Admins only.');
  }

  res.render('languages', { languages: [], admin: req.admin });
});

router.get('/api/display-config', languageController.getDisplayConfigs);
router.put('/api/languages/:id/display-config', requireAuth, languageController.updateDisplayConfig);
router.get('/api/languages', languageController.getAllLanguages);
router.get('/api/languages/:id', languageController.getLanguageById);
router.post('/api/languages', languageController.createLanguage);
router.put('/api/languages/:id', languageController.updateLanguage);
router.delete('/api/languages/:id', languageController.deleteLanguage);
router.patch('/api/languages/:id/toggle', languageController.toggleLanguageStatus);
router.patch('/api/languages/:id/default', languageController.setDefaultLanguage);
router.post('/api/sync-reporter-languages', languageController.syncReporterLanguages);

module.exports = router;
