'use strict';

/**
 * One registered FCM device token = one phone we can push to directly.
 *
 * Why this exists: FCM *topic* sends (news_all, news_<lang>, user_<id>) return
 * only a message id — Firebase never tells us how many phones received them.
 * To show a real "delivered to N phones" count in Notification Studio we must
 * send to individual device tokens (multicast) and count the successes. The app
 * registers its token here on launch / sign-in / token refresh.
 *
 * Additive and isolated: nothing else depends on this collection. Invalid tokens
 * are pruned automatically after a send reports them unregistered.
 */
const mongoose = require('mongoose');

const deviceTokenSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true, index: true },
  userId: { type: String, default: '', index: true }, // Google sub when signed in
  language: { type: String, default: '', index: true },
  platform: { type: String, default: 'android' },
  appVersion: { type: String, default: '' },
  lastSeenAt: { type: Date, default: Date.now, index: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports =
  mongoose.models.DeviceToken || mongoose.model('DeviceToken', deviceTokenSchema);
