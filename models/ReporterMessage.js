'use strict';

const mongoose = require('mongoose');

/**
 * A personal message from the desk (admin / superadmin) to ONE reporter.
 * Shown in the reporter app's Alerts list (alongside approve / reject /
 * revision alerts) and delivered as a push. Additive collection — nothing
 * else in the system depends on it.
 */
const reporterMessageSchema = new mongoose.Schema(
  {
    reporterId: { type: String, required: true, index: true }, // Admin _id of the reporter
    title: { type: String, default: 'Message from Tehelka News', trim: true, maxlength: 80 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    fromAdminId: { type: String },
    fromAdminName: { type: String },
    fromAdminRole: { type: String },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

reporterMessageSchema.index({ reporterId: 1, createdAt: -1 });

module.exports = mongoose.models.ReporterMessage || mongoose.model('ReporterMessage', reporterMessageSchema);
