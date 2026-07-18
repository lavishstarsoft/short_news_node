const mongoose = require('mongoose');

const textStyleDefaults = {
  color: { type: String, default: '#1F2937' },
  fontSize: { type: Number, default: 14 },
  bold: { type: Boolean, default: false },
  underline: { type: Boolean, default: false }
};

const reporterEarningSchema = new mongoose.Schema(
  {
    language: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    pageBgColor: { type: String, default: '#F3F4F6' },

    // Hero banner (image only)
    heroImageUrl: { type: String, default: '' },

    // Greeting
    greetingTitle: { type: String, default: '' },
    greetingTitleColor: { type: String, default: '#111827' },
    greetingTitleFontSize: { type: Number, default: 18 },
    greetingTitleBold: { type: Boolean, default: true },
    greetingTitleUnderline: { type: Boolean, default: false },
    greetingBody: { type: String, default: '' },
    greetingBodyColor: { type: String, default: '#374151' },
    greetingBodyFontSize: { type: Number, default: 14 },

    // Dashed highlight box
    highlightText: { type: String, default: '' },
    highlightBgColor: { type: String, default: '#FFFFFF' },
    highlightTextColor: { type: String, default: '#111827' },
    highlightBorderColor: { type: String, default: '#111827' },
    highlightFontSize: { type: Number, default: 14 },
    highlightBold: { type: Boolean, default: false },

    // Info to send
    infoTitle: { type: String, default: '' },
    infoTitleColor: { type: String, default: '#111827' },
    infoTitleFontSize: { type: Number, default: 17 },
    infoTitleBold: { type: Boolean, default: true },
    infoTitleUnderline: { type: Boolean, default: false },
    infoIntro: { type: String, default: '' },
    infoIntroColor: { type: String, default: '#374151' },
    infoIntroFontSize: { type: Number, default: 14 },
    infoItems: { type: [String], default: [] },
    infoItemColor: { type: String, default: '#1F2937' },
    infoItemFontSize: { type: Number, default: 14 },
    infoBulletColor: { type: String, default: '#111827' },

    // Income explanation
    incomeTitle: { type: String, default: '' },
    incomeTitleColor: { type: String, default: '#111827' },
    incomeTitleFontSize: { type: Number, default: 17 },
    incomeTitleBold: { type: Boolean, default: true },
    incomeTitleUnderline: { type: Boolean, default: false },
    incomeBody: { type: String, default: '' },
    incomeBodyColor: { type: String, default: '#374151' },
    incomeBodyFontSize: { type: Number, default: 14 },

    // Sign-off
    signoffText: { type: String, default: '' },
    signoffColor: { type: String, default: '#111827' },
    signoffFontSize: { type: Number, default: 15 },
    signoffBold: { type: Boolean, default: true },

    // Bottom CTA
    ctaText: { type: String, default: '' },
    ctaUrl: { type: String, default: 'https://wa.me/' },
    ctaBgColor: { type: String, default: '#16A34A' },
    ctaTextColor: { type: String, default: '#FFFFFF' },
    ctaFontSize: { type: Number, default: 15 },
    ctaBold: { type: Boolean, default: true },
    ctaEnabled: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReporterEarning', reporterEarningSchema);
