const mongoose = require('mongoose');

/**
 * Which reporter accounts have been used on which phone. One row per
 * (deviceId, adminId) — written on every reporter app login and news post.
 *
 * This is what catches "one person, many stringer accounts": the accounts share
 * a phone even when they use different UPI IDs and mobile numbers.
 */
const reporterDeviceLinkSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
  username: { type: String, default: '' },
  deviceModel: { type: String, default: '' },
  platform: { type: String, default: '' },
  appVersion: { type: String, default: '' },
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  logins: { type: Number, default: 0 },
  newsPosts: { type: Number, default: 0 },
});

reporterDeviceLinkSchema.index({ deviceId: 1, adminId: 1 }, { unique: true });
reporterDeviceLinkSchema.index({ adminId: 1, lastSeenAt: -1 });
reporterDeviceLinkSchema.index({ deviceId: 1, lastSeenAt: -1 });

module.exports = mongoose.model('ReporterDeviceLink', reporterDeviceLinkSchema);
