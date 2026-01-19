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
    enum: ['admin', 'superadmin', 'editor']
  },
  isActive: {
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
  mobileNumber: {
    type: String,
    default: null
  },
  lastLogin: {
    type: Date
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