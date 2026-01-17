const mongoose = require('mongoose');

const adSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String },
  imageUrl: { type: String }, // Kept for backward compatibility
  imageUrls: { type: [String], default: [] }, // New field for multiple images
  linkUrl: { type: String },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  author: { type: String, required: true },
  authorId: { type: String, required: true },
  // Position where the ad should appear (every 3rd, 5th, etc. news item)
  positionInterval: { type: Number, default: 3 },
  // Intelligent ad management fields
  maxViewsPerDay: { type: Number, default: 3 }, // Maximum views per user per day
  cooldownPeriodHours: { type: Number, default: 24 }, // Minimum hours between views for same user
  frequencyControlEnabled: { type: Boolean, default: true }, // Enable/disable frequency control
  userBehaviorTrackingEnabled: { type: Boolean, default: true }, // Enable/disable user behavior tracking
  // AdMob integration fields
  useAdMob: { type: Boolean, default: false }, // Enable AdMob for this ad
  adMobAppId: { type: String }, // AdMob App ID
  adMobUnitId: { type: String }, // AdMob Unit ID
});

module.exports = mongoose.model('Ad', adSchema);