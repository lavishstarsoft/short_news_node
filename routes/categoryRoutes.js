const express = require('express');
const router = express.Router();
const categoryController = require('../controllers/categoryController');
const { requireAuth } = require('../controllers/adminController');
const { uploadCategoryMedia } = require('../middleware/upload');

// Get categories page
router.get('/', requireAuth, categoryController.getAllCategories);

// API Routes for categories
router.get('/api/categories', categoryController.getCategoriesWithCount);
router.get('/api/categories/stats', categoryController.getCategoryStats);
router.get('/api/categories/:id', categoryController.getCategoryById);
router.post('/api/categories', uploadCategoryMedia.single('image'), categoryController.createCategory);
router.put('/api/categories/:id', uploadCategoryMedia.single('image'), categoryController.updateCategory);
router.delete('/api/categories/:id', categoryController.deleteCategory);
router.patch('/api/categories/:id/toggle', categoryController.toggleCategoryStatus);

module.exports = router;