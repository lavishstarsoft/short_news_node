const mongoose = require('mongoose');

const appSettingsSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    default: 'update_flags'
  },
  androidVersion: {
    type: String,
    required: true,
    default: '1.0.0'
  },
  iosVersion: {
    type: String,
    required: true,
    default: '1.0.0'
  },
  forceUpdate: {
    type: Boolean,
    default: false
  },
  androidUpdateUrl: {
    type: String,
    default: 'https://play.google.com/store/apps/details?id=com.lavish.yellowsingam'
  },
  iosUpdateUrl: {
    type: String,
    default: 'https://apps.apple.com/app/tehelka-news-daily-news-app/id6772203356'
  },
  updateMessage: {
    type: String,
    default: 'A new version of the app is available. Please update to continue.'
  },
  swipeStreakMilestone: {
    type: Number,
    default: 30
  },
  isSwipeStreakEnabled: {
    type: Boolean,
    default: true
  },
  showLongVideos: {
    type: Boolean,
    default: true
  },
  showDistrictSelection: {
    type: Boolean,
    default: false
  },
  /** When true, Flutter shows location onboarding + drawer location UI. */
  enableLocationModule: {
    type: Boolean,
    default: true
  },
  calendarEnabledLanguages: {
    type: [String],
    default: ['te']
  },
  zodiacEnabledLanguages: {
    type: [String],
    default: ['te']
  },

  contactUs: {
    type: String,
    default: ''
  },
  privacyPolicy: {
    type: String,
    default: ''
  },
  aboutUs: {
    type: String,
    default: ''
  },
  termsAndConditions: {
    type: String,
    default: ''
  },
  feedbackUrl: {
    type: String,
    default: 'https://wa.me/919999999999'
  },
  referralHelpText: {
    type: String,
    default: 'Invite your friends to earn rewards when they join and use the app for 7 days.'
  },
  referralRewardAmount: {
    type: Number,
    default: 5
  },
  referralRequiredDays: {
    type: Number,
    default: 7
  },
  maxDailyReferralBudget: {
    type: Number,
    default: 5000
  },
  referralShareUrl: {
    type: String,
    default: 'https://play.google.com/store/apps/details?id=com.lavish.yellowsingam'
  },
  isReferralEnabled: {
    type: Boolean,
    default: true
  },
  reporterMaxDailyReward: {
    type: Number,
    default: 30
  },
  // P6 — per-approved-news rate for tiered reporters (Super Admin configurable).
  // Defaults preserve the original hard-coded P3 rates (₹5 / ₹10).
  stringerRatePerNews: {
    type: Number,
    default: 5
  },
  districtInchargeRatePerNews: {
    type: Number,
    default: 10
  },
  reporterTargetNews: {
    type: Number,
    default: 5
  },
  minWithdrawalAmount: {
    type: Number,
    default: 500
  },
  maxWithdrawalAmount: {
    type: Number,
    default: 5000
  },
  /** When true, reporters Next.js site can open in normal browsers; when false, WebView/app only. */
  allowReporterBrowserAccess: {
    type: Boolean,
    default: false
  },
  enableAIAssistant: {
    type: Boolean,
    default: true
  },
  /**
   * Master ON/OFF switch for the Smart View Distribution Engine (isolated plug-in).
   * false (default) => engine never runs and consumer responses are identical to today.
   * See services/viewDistribution/ for the fully isolated module.
   */
  viewEngineEnabled: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

module.exports = mongoose.model('AppSettings', appSettingsSchema);
