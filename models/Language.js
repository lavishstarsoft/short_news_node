const mongoose = require('mongoose');

const languageSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    minlength: 2,
    maxlength: 10
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  nativeName: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  isActive: {
    type: Boolean,
    default: true
  },
  showInUserApp: {
    type: Boolean,
    default: true
  },
  isDefault: {
    type: Boolean,
    default: false
  },
  sortOrder: {
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

languageSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

languageSchema.statics.getActiveLanguages = function () {
  return this.find({ isActive: true }).sort({ sortOrder: 1, name: 1 });
};

module.exports = mongoose.model('Language', languageSchema);
