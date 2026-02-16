const mongoose = require('mongoose');

const adInteractionSchema = new mongoose.Schema({
    adId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ad', required: true },
    adTitle: { type: String },
    interactionType: { type: String, enum: ['view', 'click'], required: true },
    viewDurationSeconds: { type: Number, default: 0 },
    userId: { type: String }, // Optional, if user is logged in
    platform: { type: String }, // 'ios', 'android', 'web'
    timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AdInteraction', adInteractionSchema);
