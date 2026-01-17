const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true, 
    unique: true,
    trim: true,
    minlength: 2,
    maxlength: 50
  },
  teluguName: { 
    type: String, 
    required: false,
    trim: true,
    maxlength: 100
  },
  code: { 
    type: String, 
    required: true,
    unique: true,
    trim: true,
    minlength: 2,
    maxlength: 10
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
locationSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Static method to get active locations
locationSchema.statics.getActiveLocations = function() {
  return this.find({ isActive: true }).sort({ name: 1 });
};

module.exports = mongoose.model('Location', locationSchema);