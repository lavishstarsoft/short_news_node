const mongoose = require('mongoose');

const guidelineItemSchema = new mongoose.Schema(
  {
    text: { type: String, default: '' },
    underline: { type: Boolean, default: false },
    bold: { type: Boolean, default: false },
    color: { type: String, default: '' }
  },
  { _id: false }
);

const guidelineCardSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    /** intro | list | text | note */
    type: { type: String, default: 'text' },
    title: { type: String, default: '' },
    body: { type: String, default: '' },
    items: { type: [guidelineItemSchema], default: [] },
    // Design
    backgroundColor: { type: String, default: '#FFFFFF' },
    titleColor: { type: String, default: '#111827' },
    bodyColor: { type: String, default: '#4B5563' },
    accentColor: { type: String, default: '#E31E24' },
    borderColor: { type: String, default: '#F3F4F6' },
    titleFontSize: { type: Number, default: 15 },
    bodyFontSize: { type: Number, default: 13 },
    titleUnderline: { type: Boolean, default: false },
    titleBold: { type: Boolean, default: true },
    borderRadius: { type: Number, default: 16 },
    showIcon: { type: Boolean, default: true },
    iconBgColor: { type: String, default: '#FEF2F2' },
    iconColor: { type: String, default: '#E31E24' }
  },
  { _id: false }
);

const reporterGuidelinesSchema = new mongoose.Schema(
  {
    language: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    pageTitle: { type: String, default: 'Reporter Guidelines' },
    pageTitleColor: { type: String, default: '#111827' },
    pageTitleFontSize: { type: Number, default: 17 },
    pageTitleUnderline: { type: Boolean, default: false },
    pageBgColor: { type: String, default: '#F8F9FA' },
    footerText: { type: String, default: '' },
    footerColor: { type: String, default: '#9CA3AF' },
    footerFontSize: { type: Number, default: 12 },
    cards: { type: [guidelineCardSchema], default: [] }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReporterGuidelines', reporterGuidelinesSchema);
