const mongoose = require('mongoose');

const pendingReferralSchema = new mongoose.Schema({
  referralCode: {
    type: String,
    required: true,
    index: true
  },
  ipAddress: {
    type: String,
    required: true,
    index: true
  },
  userAgent: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 3600 // Auto-delete document after 1 hour (3600 seconds)
  }
});

// Index to quickly find matches
pendingReferralSchema.index({ ipAddress: 1, userAgent: 1 });

module.exports = mongoose.model('PendingReferral', pendingReferralSchema);
