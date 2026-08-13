'use strict';

const mongoose = require('mongoose');

/**
 * LateApprovalReason — IMMUTABLE per-news accountability record capturing the
 * mandatory reason a State In-Charge typed when approving a reporter's news late.
 *
 * Two severities:
 *   - 'same_day_late' : approved > 30 min after submission, SAME calendar day.
 *                       Reason + warning + Super-Admin visibility. Earning is
 *                       UNCHANGED (auto-credited as before) — NOT frozen.
 *   - 'day_late'      : approval crossed the submission calendar day. Reason +
 *                       strong warning + earning held (existing Day-Level hold).
 *
 * `newsId` is UNIQUE → duplicate approval / retry / refresh cannot create a
 * duplicate reason or duplicate warning. The reason text is immutable once set;
 * the In-Charge can never edit or delete it.
 */
const schema = new mongoose.Schema(
  {
    newsId: { type: String, required: true, unique: true, index: true },
    newsTitle: { type: String, default: '' },

    reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null, index: true },
    reporterName: { type: String, default: '' },

    stateInchargeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null, index: true },
    stateInchargeName: { type: String, default: '' },

    submittedAt: { type: Date, required: true },
    approvalAttemptAt: { type: Date, required: true },
    approvedAt: { type: Date, required: true },
    approvalDelayMinutes: { type: Number, required: true },

    lateApproval: { type: Boolean, default: true },
    lateApprovalType: { type: String, enum: ['same_day_late', 'day_late'], required: true },
    lateApprovalReason: { type: String, required: true }, // immutable once created

    earningAmount: { type: Number, default: 0 },
    // Mirrors the financial outcome for transparency (not the source of truth for the wallet).
    earningStatus: { type: String, default: '' }, // auto_credited | pending_superadmin_review | released | sent_back
    referenceId: { type: String, default: '' }, // link to the day-reward key (day_late only)

    superAdminAction: {
      byId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
      byName: { type: String, default: '' },
      action: { type: String, default: '' },
      at: { type: Date, default: null }
    },
    earningReleasedAt: { type: Date, default: null }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Immutable: the reason and core facts can never change after creation; block deletes.
schema.pre('save', function (next) {
  if (this.isNew) return next();
  const frozen = ['lateApprovalReason', 'newsId', 'submittedAt', 'approvedAt', 'approvalDelayMinutes', 'lateApprovalType', 'stateInchargeId'];
  if (frozen.some((f) => this.isModified(f))) return next(new Error('LateApprovalReason core fields are immutable.'));
  next();
});
['deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndUpdate', 'updateOne', 'updateMany'].forEach((op) => {
  schema.pre(op, function (next) { next(new Error(`LateApprovalReason is append-only — ${op} is not permitted.`)); });
});

module.exports = mongoose.model('LateApprovalReason', schema);
