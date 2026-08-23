'use strict';

/**
 * P4 — Emergency daily-limit override for a TIERED reporter, for ONE IST day only.
 *
 * A granted override raises that reporter's effective submission cap for `dateKey`
 * to (10 + extraAllowed). It auto-expires because enforcement only ever matches on
 * dateKey === istDateKey(now) — yesterday's row never applies today. Revoking sets
 * status='revoked' → immediately restores the normal cap.
 *
 * Minimal + scoped. No wallet/reward data lives here. No migration/backfill.
 */

const mongoose = require('mongoose');

const reporterAccessOverrideSchema = new mongoose.Schema(
  {
    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
    dateKey: { type: String, required: true, index: true }, // IST "YYYY-MM-DD" (server-set)
    extraAllowed: { type: Number, required: true, min: 0, default: 0 },
    status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },

    grantedById: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    grantedByName: { type: String, default: '' },
    grantedByRole: { type: String, default: '' },

    revokedById: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    revokedByName: { type: String, default: '' },
    revokedByRole: { type: String, default: '' },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Exactly one override row per reporter per IST day (grants accumulate onto it).
reporterAccessOverrideSchema.index({ reporterId: 1, dateKey: 1 }, { unique: true });

module.exports = mongoose.model('ReporterAccessOverride', reporterAccessOverrideSchema);
