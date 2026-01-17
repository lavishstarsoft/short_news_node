const mongoose = require('mongoose');

const adAnalyticsSchema = new mongoose.Schema({
  adId: { type: String, required: true, index: true },
  adTitle: { type: String, required: true },
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  ctr: { type: Number, default: 0 }, // Click-through rate
  avgViewDurationSeconds: { type: Number, default: 0 },
  uniqueViews: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Index for better query performance
adAnalyticsSchema.index({ adId: 1, createdAt: -1 });

module.exports = mongoose.model('AdAnalytics', adAnalyticsSchema);