'use strict';

/**
 * DeviceLink — records which quiz accounts (verified googleId) have been used from a
 * given physical install (deviceId sent by the app, best-effort). Used ONLY for
 * fair-play analysis in the weekly prize draw: if many distinct accounts share one
 * deviceId, that cluster is flagged for human review. It is never a hard block on
 * playing, and the deviceId is treated as an untrusted hint (client-supplied).
 */
const mongoose = require('mongoose');

const deviceLinkSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },   // opaque per-install UUID from the app
  userId: { type: String, required: true },     // verified googleId
  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  hitCount: { type: Number, default: 0 },        // how many times this pair was seen
}, { timestamps: true });

deviceLinkSchema.index({ deviceId: 1, userId: 1 }, { unique: true }); // one row per pair
deviceLinkSchema.index({ deviceId: 1 }); // "which accounts on this device?"
deviceLinkSchema.index({ userId: 1 });   // "which devices for this account?"

module.exports = mongoose.model('DeviceLink', deviceLinkSchema);
