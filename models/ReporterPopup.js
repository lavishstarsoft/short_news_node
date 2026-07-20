const mongoose = require('mongoose');

/**
 * In-app popup notifications: superadmin creates, reporters app shows.
 * language: existing news language codes (te/hi/en...) — reporter's
 * workingLanguage tho exact match ayithe matrame display avtundi.
 */
const reporterPopupSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  message: { type: String, required: true, trim: true, maxlength: 1000 },
  language: { type: String, required: true, lowercase: true, trim: true, index: true },

  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },

  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  isActive: { type: Boolean, default: true },

  // Ela frequent ga chupinchali (dismiss ayyaka)
  frequency: {
    type: String,
    enum: ['once', 'once_per_day', 'every_login', 'always'],
    default: 'once'
  },

  buttonText: { type: String, default: '', trim: true, maxlength: 40 },
  buttonUrl: { type: String, default: '', trim: true },
  imageUrl: { type: String, default: '', trim: true },

  target: {
    audience: {
      type: String,
      enum: ['all', 'reporters', 'roles', 'states', 'districts'],
      default: 'all'
    },
    reporterIds: { type: [String], default: [] },
    roles: { type: [String], default: [] },       // editor / subeditor
    states: { type: [String], default: [] },
    districts: { type: [String], default: [] }
  },

  createdBy: { type: String, default: '' },
  createdByName: { type: String, default: '' }
}, { timestamps: true });

// Reporter fetch query ki main index
reporterPopupSchema.index({ isActive: 1, language: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model('ReporterPopup', reporterPopupSchema);
