const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  // Who shared the referral link
  referrerUserId: {
    type: String,
    required: true,
    index: true
  },
  referrerEmail: {
    type: String,
    default: null
  },

  // Who installed via the link
  referredUserId: {
    type: String,
    required: true,
    index: true
  },
  referredEmail: {
    type: String,
    default: null
  },

  // The referral code used
  referralCode: {
    type: String,
    required: true,
    index: true
  },

  // --- Fraud Detection Fields ---

  // Device fingerprint (Android ID hash) — blocks same-device re-installs
  deviceFingerprint: {
    type: String,
    required: true,
    index: true
  },

  // IP address at install time — for rate limiting
  installIp: {
    type: String,
    default: null
  },

  // Raw Play Install Referrer data from Google
  installReferrerData: {
    type: String,
    default: null
  },

  // --- Status & Commission ---

  status: {
    type: String,
    enum: ['pending', 'verified', 'paid', 'rejected'],
    default: 'pending',
    index: true
  },

  rejectionReason: {
    type: String,
    enum: [
      null,
      'duplicate_user',
      'duplicate_device',
      'ip_rate_limit',
      'self_referral',
      'insufficient_usage',
      'manual_reject'
    ],
    default: null
  },

  commissionAmount: {
    type: Number,
    default: 5 // ₹5 per successful referral
  },

  // --- Usage Tracking (7-day retention check) ---

  appOpenCount: {
    type: Number,
    default: 0
  },

  totalUsageMinutes: {
    type: Number,
    default: 0
  },

  lastUsageUpdate: {
    type: Date,
    default: null
  },

  // --- Timestamps ---

  verifiedAt: {
    type: Date,
    default: null
  },

  paidAt: {
    type: Date,
    default: null
  },
  integrityData: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
    description: 'Raw data from Google Play Integrity API'
  }
}, {
  timestamps: true // adds createdAt, updatedAt
});

// Compound indexes for fraud detection queries
referralSchema.index({ deviceFingerprint: 1, status: 1 });
referralSchema.index({ installIp: 1, createdAt: -1 });
referralSchema.index({ referredUserId: 1 }, { unique: true }); // One referral per user
referralSchema.index({ status: 1, createdAt: 1 }); // For cron job queries

module.exports = mongoose.model('Referral', referralSchema);
