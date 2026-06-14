const express = require('express');
const router = express.Router();
const categoryController = require('../controllers/categoryController');
const { requireAuth } = require('../controllers/adminController');
const { uploadCategoryMedia } = require('../middleware/upload');

// Get categories page
router.get('/', requireAuth, categoryController.getAllCategories);

// API Routes for categories
// Reads stay public (used by the mobile app); writes require admin auth.
router.get('/api/categories', categoryController.getCategoriesWithCount);
router.get('/api/categories/stats', categoryController.getCategoryStats);
router.get('/api/categories/:id', categoryController.getCategoryById);
router.post('/api/categories', requireAuth, uploadCategoryMedia.single('image'), categoryController.createCategory);
router.put('/api/categories/:id', requireAuth, uploadCategoryMedia.single('image'), categoryController.updateCategory);
router.delete('/api/categories/:id', requireAuth, categoryController.deleteCategory);
router.patch('/api/categories/:id/toggle', requireAuth, categoryController.toggleCategoryStatus);

module.exports = router;