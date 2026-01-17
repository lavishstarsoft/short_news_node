const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true, 
    unique: true,
    trim: true,
    minlength: 2,
    maxlength: 50
  },
  description: { 
    type: String, 
    required: true,
    trim: true,
    maxlength: 200
  },
  color: { 
    type: String, 
    required: true,
    default: '#007bff',
    match: /^#[0-9A-Fa-f]{6}$/
  },
  icon: { 
    type: String, 
    required: true,
    default: 'fas fa-folder'
  },
  imageUrl: { 
    type: String,
    default: '/uploads/default-category.png'
  },
  isActive: { 
    type: Boolean, 
    default: true 
  },
  newsCount: { 
    type: Number, 
    default: 0 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date, 
    default: Date.now 
  }
});

// Update the updatedAt field before saving
categorySchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Static method to get active categories
categorySchema.statics.getActiveCategories = function() {
  return this.find({ isActive: true }).sort({ name: 1 });
};

// Static method to get category with news count
categorySchema.statics.getCategoriesWithCount = async function() {
  return this.aggregate([
    {
      $lookup: {
        from: 'news',
        localField: '_id',
        foreignField: 'category',
        as: 'news'
      }
    },
    {
      $addFields: {
        newsCount: { $size: '$news' }
      }
    },
    {
      $project: {
        news: 0
      }
    },
    {
      $sort: { name: 1 }
    }
  ]);
};

module.exports = mongoose.model('Category', categorySchema);