const mongoose = require('mongoose');

const adSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String },
  imageUrl: { type: String }, // Kept for backward compatibility
  imageUrls: { type: [String], default: [] }, // New field for multiple images
  linkUrl: { type: String },
  adFormat: { type: String, enum: ['image_only', 'news_format'], default: 'image_only' },
  buttonText: { type: String },
  isActive: { type: Boolean, default: true },
  scheduleEnabled: { type: Boolean, default: false },
  scheduleStart: { type: Date },
  scheduleEnd: { type: Date },
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
  priority: { type: String, enum: ['high', 'medium', 'low'], default: 'medium' }, // Ad priority
  // Bid / weight: how much the advertiser pays → higher = shown MORE (weighted
  // auction among the language's due ads). 0 = no bid (falls back to priority).
  bidAmount: { type: Number, default: 0 },
  // Impression budget: auto-pause the ad once it has been shown this many times
  // (0 = unlimited). impressionCount is incremented on every 'view'.
  maxImpressions: { type: Number, default: 0 },
  impressionCount: { type: Number, default: 0 },
  // Per-ad toggle for the app's ad bottom bar (Viral / WhatsApp / 3-dots / Share).
  // Default OFF — the bar shows only on ads the admin explicitly enables.
  showBottomBar: { type: Boolean, default: false },
  language: { type: String, required: true }, // The language this ad belongs to (e.g. 'en', 'te', 'hi')
  // Optional content category (same taxonomy as News) — used by Phase 2b to match
  // an ad to a user's implicitly-learned interests. '' = general / uncategorised.
  category: { type: String, default: '' },
});

adSchema.index({ scheduleEnabled: 1, scheduleStart: 1, scheduleEnd: 1 });
adSchema.index({ isActive: 1, language: 1, createdAt: -1 });

module.exports = mongoose.model('Ad', adSchema);