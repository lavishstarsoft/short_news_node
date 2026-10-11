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
    default: '/images/default_user_icon.png'
  },
  displayRole: {
    type: String,
    default: 'Reporter'
  },
  // Payout tier for reporters. null = existing behavior (no tier rules applied).
  // Enum values are reserved for future phases; nothing is activated in P1.
  reporterTier: {
    type: String,
    enum: ['stringer', 'district_incharge', null],
    default: null
  },
  // Salary-based reporters (e.g. Delhi team) are paid a monthly salary, NOT per-news,
  // so the tiered 10-news/day submission cap must not apply to them. Additive &
  // nullable: absent/false = normal tier limit; true = unlimited daily submissions.
  unlimitedDailyNews: {
    type: Boolean,
    default: false
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
  /** State In-Charge agreement lifecycle (additive; default null = not started). */
  agreementStatus: {
    type: String,
    enum: ['invited', 'otp_verified', 'agreement_accepted', 'approved', 'appointed', null],
    default: null
  },
  /** Monthly salary — Admin/Super Admin set only; null = not set. Shown on Staff Record PDF. */
  salary: {
    type: Number,
    default: null,
    min: 0
  },
  lastLogin: {
    type: Date
  },
  /**
   * ONE-DEVICE LOGIN (Reporter Security Phase 2). The session the account is
   * currently allowed to use; a new login replaces it and the old device's token
   * stops working (its `sid` no longer matches). Null = no session recorded yet
   * (older tokens keep working until the rule is switched on).
   */
  activeSession: {
    sid: { type: String, default: null },
    deviceId: { type: String, default: '' },
    deviceModel: { type: String, default: '' },
    platform: { type: String, default: '' },
    appVersion: { type: String, default: '' },
    ip: { type: String, default: '' },
    place: { type: String, default: '' },
    at: { type: Date, default: null }
  },
  /** Web dashboard session (kept separate so a phone login never kicks the desk browser). */
  activeWebSession: {
    sid: { type: String, default: null },
    ip: { type: String, default: '' },
    place: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    at: { type: Date, default: null }
  },
  /** Who created this account (dashboard Register Editor). null = older accounts / self sign-up. */
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null
  },
  /** 'dashboard' = created by an admin; 'portal_signup' = self-registered on the reporter web portal. */
  createdVia: {
    type: String,
    enum: ['dashboard', 'portal_signup', null],
    default: null
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
      enum: ['upi', 'bank', 'phonepe'],
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
    // PhonePe payout: the 10-digit mobile the reporter receives money on.
    phoneNumber: {
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
    /**
     * Sub-editor News AI duplicate check.
     * true (default): posted news goes through async AI verification before auto-publish.
     * false: super admin disabled AI for this sub-editor → news is published directly (no AI gate).
     */
    aiCheckEnabled: { type: Boolean, default: true },
    approvalScope: { 
      type: String, 
      enum: ['all', 'locations', 'geography', 'reporters', 'geography_and_reporters'],
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
      zodiac: { type: Boolean, default: false },
      // Sub-editor standalone links (Assign Reporters / Reporter Access / Coverage Map).
      // Visible by default; a super admin can hide them per sub-editor.
      assignReporters: { type: Boolean, default: true },
      reporterAccess: { type: Boolean, default: true },
      coverageMap: { type: Boolean, default: true }
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
  }],

  // ── Phase-A ORGANIZATION METADATA (additive, nullable — read by NOTHING yet) ──
  // These fields carry future org structure only. They grant ZERO permissions,
  // are ignored by authentication/authorization/workflows, and a document with
  // all of them null/empty behaves exactly as before. Legacy fields (role,
  // permissions, displayRole, reporterTier, assigned*, managed*) remain
  // authoritative. Do NOT read these from any controller until the approved
  // dual-run phase.
  departmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Department',
    default: null,
    index: true
  },
  teamId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Team',
    default: null,
    index: true
  },
  roleIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Role'
  }],
  reportingManagerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null,
    index: true
  }
}, {
  timestamps: true
});

// Multikey index for future role-holder lookups ("who has role X?").
adminSchema.index({ roleIds: 1 });

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