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
  unicodeRange: {
    type: String,
    trim: true,
    default: ''
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
  displayConfig: {
    titleMax: { type: Number, min: 20, max: 120 },
    contentMax: { type: Number, min: 80, max: 1200 },
    contentMin: { type: Number, min: 0, max: 1000 },
    titleFontSize: { type: Number, min: 10, max: 32 },
    contentFontSize: { type: Number, min: 10, max: 32 },
    titleLineHeight: { type: Number, min: 1, max: 2.5 },
    contentLineHeight: { type: Number, min: 1, max: 2.5 },
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
