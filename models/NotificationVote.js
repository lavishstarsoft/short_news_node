const mongoose = require('mongoose');

/**
 * One person's answer to a poll notification. Unique per (campaign, voter) so a
 * second tap changes the answer instead of inflating the count.
 *
 * `voterKey` is the app user's id when known, else the per-install device id —
 * a reader who never signed in can still vote once from their phone.
 */
const notificationVoteSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'NotificationCampaign', required: true, index: true },
  voterKey: { type: String, required: true },
  optionId: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  platform: { type: String, default: '' },
  at: { type: Date, default: Date.now },
});

notificationVoteSchema.index({ campaignId: 1, voterKey: 1 }, { unique: true });
notificationVoteSchema.index({ at: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

module.exports = mongoose.model('NotificationVote', notificationVoteSchema);
