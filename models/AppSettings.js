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
  }
}, { timestamps: true });

module.exports = mongoose.model('AppSettings', appSettingsSchema);
