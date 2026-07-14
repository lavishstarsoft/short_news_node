const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: { type: String, sparse: true, unique: true }, // Make optional but unique if provided
  email: { type: String, sparse: true, unique: true }, // Optional email
  mobileNumber: { type: String, sparse: true, unique: true }, // Optional mobile
  displayName: { type: String, required: true },
  photoUrl: { type: String },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: Date.now },

  // --- Referral System ---
  referralCode: { type: String, sparse: true, index: true }, // Removed unique: true to allow multiple users on same device to share code
  referredBy: { type: String, default: null }, // referral code used during install
  walletBalance: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  totalReferrals: { type: Number, default: 0 },
  deviceFingerprint: { type: String, default: null },

  locationProfile: {
    primaryState: { type: String, default: null },
    primaryDistrict: { type: String, default: null },
    coordinates: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null }
    },
    source: {
      type: String,
      enum: ['gps', 'manual', 'inferred'],
      default: null
    },
    additionalLocations: [{ type: String }],
    updatedAt: { type: Date, default: null }
  },
  interactions: {
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'News' }],
    dislikes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'News' }],
    comments: [{ 
      newsId: { type: mongoose.Schema.Types.ObjectId, ref: 'News' },
      comment: String,
      timestamp: { type: Date, default: Date.now }
    }]
  }
});

// Auto-generate unique referral code on first save or inherit from device
userSchema.pre('save', async function (next) {
  if (!this.referralCode) {
    if (this.deviceFingerprint) {
      try {
        // Check if any other user on this device already has a referral code
        const existingUser = await this.constructor.findOne({ 
          deviceFingerprint: this.deviceFingerprint,
          referralCode: { $exists: true, $ne: null }
        }).sort({ createdAt: 1 });

        if (existingUser && existingUser.referralCode) {
          this.referralCode = existingUser.referralCode;
          return next();
        }
      } catch (err) {
        console.error('Error finding existing device user for referral:', err);
      }
    }

    const crypto = require('crypto');
    this.referralCode = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8-char hex: e.g. "A3F8B2C1"
  }
  next();
});

// Add indexes for better performance
userSchema.index({ googleId: 1 });
userSchema.index({ email: 1 });
userSchema.index({ referralCode: 1 });

module.exports = mongoose.model('User', userSchema);