const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  role: {
    type: String,
    default: 'editor',
    enum: ['admin', 'superadmin', 'editor', 'subeditor']
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isApproved: {
    type: Boolean,
    default: true
  },
  profileImage: {
    type: String,
    default: null
  },
  displayRole: {
    type: String,
    default: 'Reporter'
  },
  workingLanguage: {
    type: String,
    trim: true,
    lowercase: true,
    default: 'te'
  },
  name: {
    type: String,
    default: null
  },
  location: {
    type: String,
    default: null
  },
  constituency: {
    type: String,
    default: null
  },
  assignedLocations: [{
    type: String
  }],
  assignedState: {
    type: String,
    default: null
  },
  assignedStates: [{
    type: String
  }],
  assignedDistricts: [{
    type: String
  }],
  assignedConstituencies: [{
    type: String
  }],
  allowedScopes: [{
    type: String,
    enum: ['district', 'state', 'national', 'international']
  }],
  /** Sub-editor / reporter: which languages they may use on Add News. Empty = workingLanguage only. ['all'] = every active language. */
  allowedLanguages: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  mobileNumber: {
    type: String,
    default: null
  },
  lastLogin: {
    type: Date
  },
  displaySettings: {
    showProfileImage: { type: Boolean, default: true },
    showName: { type: Boolean, default: true },
    showConstituency: { type: Boolean, default: true }
  },
  // Fraud control: frozen wallet keeps balance but blocks withdrawals
  walletFrozen: {
    type: Boolean,
    default: false
  },
  walletFreezeReason: {
    type: String,
    default: ''
  },
  walletBalance: {
    type: Number,
    default: 0
  },
  /**
   * Per-reporter wallet & daily earnings config.
   * enabled=false: wallet/earnings fully hidden + no daily reward credits.
   * dailyTargetNews/dailyRewardAmount=null: global AppSettings values apply.
   */
  walletConfig: {
    enabled: { type: Boolean, default: false },
    dailyTargetNews: { type: Number, default: null, min: 1 },
    dailyRewardAmount: { type: Number, default: null, min: 1 }
  },
  /** Saved UPI / bank accounts for reporter withdrawals (max enforced in API). */
  payoutMethods: [{
    type: {
      type: String,
      enum: ['upi', 'bank'],
      required: true
    },
    label: {
      type: String,
      default: '',
      trim: true
    },
    upiId: {
      type: String,
      default: '',
      trim: true
    },
    accountHolderName: {
      type: String,
      default: '',
      trim: true
    },
    accountNumber: {
      type: String,
      default: '',
      trim: true
    },
    ifsc: {
      type: String,
      default: '',
      trim: true,
      uppercase: true
    },
    bankName: {
      type: String,
      default: '',
      trim: true
    },
    isDefault: {
      type: Boolean,
      default: false
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  permissions: {
    canViewReporterDetails: { type: Boolean, default: false },
    canAccessAdminDashboard: { type: Boolean, default: false },
    canViewAllNews: { type: Boolean, default: false },
    canApproveNews: { type: Boolean, default: false },
    canEditNews: { type: Boolean, default: false },
    canSendNotifications: { type: Boolean, default: false },
    requiresSourceLink: { type: Boolean, default: false },
    approvalScope: { 
      type: String, 
      enum: ['all', 'locations', 'geography', 'reporters'],
      default: 'all'
    },
    managedStates: [{
      type: String
    }],
    managedDistricts: [{
      type: String
    }],
    managedConstituencies: [{
      type: String
    }],
    managedReporterIds: [{
      type: String
    }],
    managedLocations: [{
      type: String
    }],
    sidebar: {
      dashboard: { type: Boolean, default: true },
      newsList: { type: Boolean, default: true },
      addNews: { type: Boolean, default: true },
      pendingNews: { type: Boolean, default: true },
      rejectedNews: { type: Boolean, default: true },
      plagiarismReport: { type: Boolean, default: true },
      viralVideos: { type: Boolean, default: true },
      polls: { type: Boolean, default: true },
      longVideos: { type: Boolean, default: true },
      categories: { type: Boolean, default: true },
      programCategories: { type: Boolean, default: true },
      locations: { type: Boolean, default: true },
      reports: { type: Boolean, default: true },
      zodiac: { type: Boolean, default: false }
    }
  },
  loginHistory: [{
    ip: String,
    userAgent: String,
    location: String,
    locationDetails: {
      city: String,
      region: String,
      country: String,
      timezone: String,
      isp: String,
      latitude: Number,
      longitude: Number,
      isVpn: {
        type: Boolean,
        default: false
      },
      riskLevel: {
        type: String,
        enum: ['low', 'medium', 'high'],
        default: 'low'
      },
      confidence: {
        type: Number,
        default: 100
      }
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});

// Hash password before saving
adminSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
adminSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Find account by username or email (trim + lowercase email for reliable matching)
adminSchema.statics.findByUsernameOrEmail = function (identifier) {
  const trimmed = (identifier || '').trim();
  if (!trimmed) return null;

  return this.findOne({
    $or: [
      { username: trimmed },
      { email: trimmed.toLowerCase() }
    ]
  });
};

// Add login history method
adminSchema.methods.addLoginHistory = function (ip, userAgent, location, locationDetails = null) {
  this.loginHistory.push({
    ip: ip,
    userAgent: userAgent,
    location: location,
    locationDetails: locationDetails,
    timestamp: new Date()
  });

  // Keep only the last 10 login records
  if (this.loginHistory.length > 10) {
    this.loginHistory = this.loginHistory.slice(-10);
  }

  return this.save();
};

module.exports = mongoose.model('Admin', adminSchema);