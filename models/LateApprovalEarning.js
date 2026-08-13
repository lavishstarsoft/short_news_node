'use strict';

const mongoose = require('mongoose');

/**
 * LateApprovalEarning — accountability + PENDING hold for a reporter's DAILY reward
 * when a State In-Charge approved the news on a LATER IST day than the submission day.
 *
 * The daily reward calculation itself is UNCHANGED (see dailyRewardService /
 * walletHelpers). This record only decides that, for a late approval, the day's
 * reward is HELD (not auto-credited) until a Super Admin releases it. The wallet is
 * credited on release through the existing processWalletTransaction() using the SAME
 * unique referenceId, so a double credit is impossible.
 *
 * `referenceId` (= reward_<reporterId>_<dateKey>) is UNIQUE → exactly one hold per
 * reporter per submission-day. Core facts are immutable; only the release/action
 * fields transition. The immutable trail lives in AuditLog.
 */
const schema = new mongoose.Schema(
  {
    // Idempotency / earning identity (same key the wallet uses).
    referenceId: { type: String, required: true, unique: true, index: true },
    dateKey: { type: String, required: true }, // submission IST day, e.g. 2026-08-09

    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
    reporterName: { type: String, default: '' },

    newsId: { type: String, required: true }, // trigger news
    stateInchargeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null, index: true },
    stateInchargeName: { type: String, default: '' },
    stateInchargeRole: { type: String, default: '' },

    submittedAt: { type: Date, required: true },   // news _id timestamp (immutable)
    approvedAt: { type: Date, required: true },     // approvalStatus.approvedAt
    approvalDelayMinutes: { type: Number, required: true },
    lateApproval: { type: Boolean, default: true },

    earningAmount: { type: Number, required: true }, // the unchanged daily reward amount
    earningStatus: {
      type: String,
      enum: ['pending_superadmin_review', 'released', 'sent_back'],
      default: 'pending_superadmin_review',
      index: true
    },

    superAdminAction: {
      byId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
      byName: { type: String, default: '' },
      action: { type: String, default: '' }, // released | sent_back
      at: { type: Date, default: null },
      note: { type: String, default: '' }
    },
    earningReleasedAt: { type: Date, default: null },
    earningReleaseDate: { type: String, default: null }, // IST day of release (never rewrites submittedAt)
    warningGeneratedAt: { type: Date, default: null }
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

// Never allow bulk delete of accountability records.
['deleteOne', 'deleteMany', 'findOneAndDelete'].forEach((op) => {
  schema.pre(op, function (next) { next(new Error(`LateApprovalEarning is append-only — ${op} is not permitted.`)); });
});

module.exports = mongoose.model('LateApprovalEarning', schema);
