const mongoose = require('mongoose');

const adInteractionSchema = new mongoose.Schema({
    adId: { type: String, required: true },
    adTitle: { type: String },
    interactionType: { type: String, enum: ['view', 'click'], required: true },
    viewDurationSeconds: { type: Number, default: 0 },
    userId: { type: String }, // Optional, if user is logged in
    platform: { type: String }, // 'ios', 'android', 'web'
    timestamp: { type: Date, default: Date.now }
});

// Indexes for analytics aggregation by ad and time
adInteractionSchema.index({ adId: 1, interactionType: 1, timestamp: -1 });
adInteractionSchema.index({ timestamp: -1 });

module.exports = mongoose.model('AdInteraction', adInteractionSchema);
