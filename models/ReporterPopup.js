const mongoose = require('mongoose');

const reporterPopupSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true
    },
    message: {
      type: String,
      required: true
    },
    language: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium'
    },
    startDate: {
      type: Date,
      default: Date.now
    },
    endDate: {
      type: Date,
      default: null
    },
    isActive: {
      type: Boolean,
      default: true
    },
    buttonText: {
      type: String,
      default: ''
    },
    buttonUrl: {
      type: String,
      default: ''
    },
    imageUrl: {
      type: String,
      default: ''
    },
    frequency: {
      type: String,
      enum: ['once', 'daily', 'always'],
      default: 'once'
    },
    // Target Audience
    targetRoles: [{
      type: String,
      enum: ['all', 'editor', 'subeditor', 'admin', 'superadmin'],
      default: ['all']
    }],
    targetStates: [{
      type: String,
      trim: true
    }],
    targetDistricts: [{
      type: String,
      trim: true
    }],
    targetReporters: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
    }],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin'
    }
  },
  { timestamps: true }
);

// Indexes for faster querying
reporterPopupSchema.index({ language: 1, isActive: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model('ReporterPopup', reporterPopupSchema);
