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
    default: ''
  },
  updateMessage: {
    type: String,
    default: 'A new version of the app is available. Please update to continue.'
  }
}, { timestamps: true });

module.exports = mongoose.model('AppSettings', appSettingsSchema);
