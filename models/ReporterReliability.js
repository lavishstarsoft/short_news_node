'use strict';

/**
 * Reporter Reliability — rolling, additive, COMPUTE-ONLY quality signal.
 *
 * IMPORTANT (product safety):
 *  - This is a SIGNAL, not an enforcement. Nothing in the platform reads this to
 *    auto-block, auto-reject or auto-restrict a reporter. Any restriction is
 *    applied by a human (superadmin/incharge) through a separate review action.
 *  - Duplicate/behavioural-fraud ONLY. It does NOT judge whether news is "fake"
 *    (misinformation) — truth verification is a separate, future signal.
 *  - No existing News record is modified to build this; it is pure aggregation.
 */

const mongoose = require('mongoose');

const reporterReliabilitySchema = new mongoose.Schema(
  {
    reporterId: { type: String, required: true, index: true },
    reporterName: { type: String, default: null },
    reporterEmail: { type: String, default: null },
    windowDays: { type: Number, default: 30 },

    // Raw counts over the window
    totalSubmissions: { type: Number, default: 0 },
    approved: { type: Number, default: 0 },
    rejected: { type: Number, default: 0 },
    exactDuplicates: { type: Number, default: 0 }, // strongest signal
    nearDuplicates: { type: Number, default: 0 }, // AI/near flagged duplicate
    suspiciousCount: { type: Number, default: 0 }, // AI-only, light weight

    // Derived
    score: { type: Number, default: null }, // 0-100, null = insufficient data
    tier: {
      type: String,
      enum: ['trusted', 'watch', 'review', 'high_risk', 'insufficient_data'],
      default: 'insufficient_data',
    },

    // Human-only restriction record. Never set automatically by any AI/cron.
    restriction: {
      level: {
        type: String,
        enum: ['none', 'warned', 'force_pending', 'rate_limited', 'suspended'],
        default: 'none',
      },
      reason: { type: String, default: null },
      appliedByName: { type: String, default: null },
      appliedById: { type: String, default: null },
      appliedAt: { type: Date, default: null },
    },

    lastComputedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

reporterReliabilitySchema.index({ reporterId: 1, windowDays: 1 }, { unique: true });
reporterReliabilitySchema.index({ tier: 1, score: 1 });

module.exports =
  mongoose.models.ReporterReliability ||
  mongoose.model('ReporterReliability', reporterReliabilitySchema);
