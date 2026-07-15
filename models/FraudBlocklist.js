const mongoose = require('mongoose');

const fraudBlocklistSchema = new mongoose.Schema({
  identifier: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  type: {
    type: String,
    enum: ['ip', 'device'],
    required: true
  },
  reason: {
    type: String,
    default: 'Suspicious activity'
  },
  blockedAt: {
    type: Date,
    default: Date.now
  },
  blockedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null
  }
});

module.exports = mongoose.model('FraudBlocklist', fraudBlocklistSchema);
