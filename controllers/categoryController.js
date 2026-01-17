const Category = require('../models/Category');
const News = require('../models/News');
const path = require('path');
const fs = require('fs');

// Get all categories
exports.getAllCategories = async (req, res) => {
  try {
    // Check if MongoDB is connected
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      const categories = await Category.find().sort({ name: 1 });
      res.render('categories', { categories, admin: req.admin });
    } else {
      // Use in-memory storage
      const categories = req.app.locals.categoryData || [];
      res.render('categories', { categories, admin: req.admin });
    }
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Error fetching categories' });
  }
};

// Get categories with news count
exports.getCategoriesWithCount = async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      const categories = await Category.getCategoriesWithCount();
      res.json(categories);
    } else {
      // Use in-memory storage
      const categories = req.app.locals.categoryData || [];
      res.json(categories);
    }
  } catch (error) {
    console.error('Error fetching categories with count:', error);
    res.status(500).json({ error: 'Error fetching categories' });
  }
};

// Get single category
exports.getCategoryById = async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      const category = await Category.findById(req.params.id);
      if (!category) {
        return res.status(404).json({ error: 'Category not found' });
      }
      res.json(category);
    } else {
      // Use in-memory storage
      const categories = req.app.locals.categoryData || [];
      const category = categories.find(cat => cat._id === req.params.id);
      if (!category) {
        return res.status(404).json({ error: 'Category not found' });
      }
      res.json(category);
    }
  } catch (error) {
    console.error('Error fetching category:', error);
    res.status(500).json({ error: 'Error fetching category' });
  }
};

// Create new category
exports.createCategory = async (req, res) => {
  try {
    const { name, description, color, icon, isActive } = req.body;
    let imageUrl = '/uploads/default-category.png';

    // Handle image upload if provided
    if (req.file) {
      console.log('Category Upload/Create - File:', req.file);
      imageUrl = req.file.path;
    }

    // Validate required fields
    if (!name || !description) {
      return res.status(400).json({
        error: 'Name and description are required'
      });
    }

    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      // Check if category already exists
      const existingCategory = await Category.findOne({
        name: { $regex: new RegExp(`^${name}$`, 'i') }
      });

      if (existingCategory) {
        return res.status(400).json({
          error: 'Category with this name already exists'
        });
      }

      const category = new Category({
        name: name.trim(),
        description: description.trim(),
        color: color || '#007bff',
        icon: icon || 'fas fa-folder',
        imageUrl: imageUrl,
        isActive: isActive !== false
      });

      await category.save();
      res.status(201).json(category);
    } else {
      // Use in-memory storage
      const categories = req.app.locals.categoryData || [];

      // Check if category already exists
      const existingCategory = categories.find(cat =>
        cat.name.toLowerCase() === name.toLowerCase()
      );

      if (existingCategory) {
        return res.status(400).json({
          error: 'Category with this name already exists'
        });
      }

      const newCategory = {
        _id: String(categories.length + 1),
        name: name.trim(),
        description: description.trim(),
        color: color || '#007bff',
        icon: icon || 'fas fa-folder',
        imageUrl: imageUrl,
        isActive: isActive !== false,
        newsCount: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      categories.push(newCategory);
      req.app.locals.categoryData = categories;
      res.status(201).json(newCategory);
    }
  } catch (error) {
    console.error('Error creating category:', error);
    res.status(400).json({ error: 'Error creating category: ' + error.message });
  }
};

// Update category
exports.updateCategory = async (req, res) => {
  try {
    const { name, description, color, icon, isActive } = req.body;
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      const category = await Category.findById(req.params.id);
      if (!category) {
        return res.status(404).json({ error: 'Category not found' });
      }

      // Check if name is being changed and if it conflicts with existing
      if (name && name !== category.name) {
        const existingCategory = await Category.findOne({
          name: { $regex: new RegExp(`^${name}$`, 'i') },
          _id: { $ne: req.params.id }
        });

        if (existingCategory) {
          return res.status(400).json({
            error: 'Category with this name already exists'
          });
        }
      }

      // Update fields
      if (name) category.name = name.trim();
      if (description) category.description = description.trim();
      if (color) category.color = color;
      if (icon) category.icon = icon;
      if (typeof isActive === 'boolean') category.isActive = isActive;

      // Handle image upload if provided
      if (req.file) {
        console.log('Category Update (MongoDB) - File path:', req.file.path);
        category.imageUrl = req.file.path;
      }

      await category.save();
      res.json(category);
    } else {
      // Use in-memory storage
      const categories = req.app.locals.categoryData || [];
      const categoryIndex = categories.findIndex(cat => cat._id === req.params.id);

      if (categoryIndex === -1) {
        return res.status(404).json({ error: 'Category not found' });
      }

      const category = categories[categoryIndex];

      // Check if name is being changed and if it conflicts with existing
      if (name && name !== category.name) {
        const existingCategory = categories.find(cat =>
          cat.name.toLowerCase() === name.toLowerCase() && cat._id !== req.params.id
        );

        if (existingCategory) {
          return res.status(400).json({
            error: 'Category with this name already exists'
          });
        }
      }

      // Update fields
      if (name) category.name = name.trim();
      if (description) category.description = description.trim();
      if (color) category.color = color;
      if (icon) category.icon = icon;
      if (typeof isActive === 'boolean') category.isActive = isActive;

      // Handle image upload if provided
      if (req.file) {
        category.imageUrl = req.file.path;
      }

      category.updatedAt = new Date();

      categories[categoryIndex] = category;
      req.app.locals.categoryData = categories;
      res.json(category);
    }
  } catch (error) {
    console.error('Error updating category:', error);
    res.status(400).json({ error: 'Error updating category: ' + error.message });
  }
};

// Delete category
exports.deleteCategory = async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      const category = await Category.findById(req.params.id);
      if (!category) {
        return res.status(404).json({ error: 'Category not found' });
      }

      // Check if category has associated news
      const newsCount = await News.countDocuments({ category: category.name });
      if (newsCount > 0) {
        return res.status(400).json({
          error: `Cannot delete category. It has ${newsCount} associated news articles. Please reassign or delete the news first.`
        });
      }

      await Category.findByIdAndDelete(req.params.id);
      res.json({ message: 'Category deleted successfully' });
    } else {
      // Use in-memory storage
      const categories = req.app.locals.categoryData || [];
      const categoryIndex = categories.findIndex(cat => cat._id === req.params.id);

      if (categoryIndex === -1) {
        return res.status(404).json({ error: 'Category not found' });
      }

      const category = categories[categoryIndex];

      // Check if category has associated news
      const newsData = req.app.locals.newsData || [];
      const newsCount = newsData.filter(news => news.category === category.name).length;

      if (newsCount > 0) {
        return res.status(400).json({
          error: `Cannot delete category. It has ${newsCount} associated news articles. Please reassign or delete the news first.`
        });
      }

      categories.splice(categoryIndex, 1);
      req.app.locals.categoryData = categories;
      res.json({ message: 'Category deleted successfully' });
    }
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(400).json({ error: 'Error deleting category: ' + error.message });
  }
};

// Toggle category status
exports.toggleCategoryStatus = async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      const category = await Category.findById(req.params.id);
      if (!category) {
        return res.status(404).json({ error: 'Category not found' });
      }

      category.isActive = !category.isActive;
      await category.save();

      res.json({
        message: `Category ${category.isActive ? 'activated' : 'deactivated'} successfully`,
        category
      });
    } else {
      // Use in-memory storage
      const categories = req.app.locals.categoryData || [];
      const categoryIndex = categories.findIndex(cat => cat._id === req.params.id);

      if (categoryIndex === -1) {
        return res.status(404).json({ error: 'Category not found' });
      }

      const category = categories[categoryIndex];
      category.isActive = !category.isActive;
      category.updatedAt = new Date();

      categories[categoryIndex] = category;
      req.app.locals.categoryData = categories;

      res.json({
        message: `Category ${category.isActive ? 'activated' : 'deactivated'} successfully`,
        category
      });
    }
  } catch (error) {
    console.error('Error toggling category status:', error);
    res.status(400).json({ error: 'Error toggling category status: ' + error.message });
  }
};

// Get category statistics
exports.getCategoryStats = async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (isConnectedToMongoDB) {
      const totalCategories = await Category.countDocuments();
      const activeCategories = await Category.countDocuments({ isActive: true });
      const inactiveCategories = totalCategories - activeCategories;

      // Get categories with news count
      const categoriesWithCount = await Category.getCategoriesWithCount();
      const totalNewsInCategories = categoriesWithCount.reduce((sum, cat) => sum + cat.newsCount, 0);

      res.json({
        totalCategories,
        activeCategories,
        inactiveCategories,
        totalNewsInCategories,
        categoriesWithCount
      });
    } else {
      // Use in-memory storage
      const categories = req.app.locals.categoryData || [];
      const totalCategories = categories.length;
      const activeCategories = categories.filter(cat => cat.isActive).length;
      const inactiveCategories = totalCategories - activeCategories;
      const totalNewsInCategories = categories.reduce((sum, cat) => sum + (cat.newsCount || 0), 0);

      res.json({
        totalCategories,
        activeCategories,
        inactiveCategories,
        totalNewsInCategories,
        categoriesWithCount: categories
      });
    }
  } catch (error) {
    console.error('Error fetching category stats:', error);
    res.status(500).json({ error: 'Error fetching category statistics' });
  }
};