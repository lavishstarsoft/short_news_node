const mongoose = require('mongoose');

/**
 * Append-only audit trail for sensitive admin actions
 * (financial actions, settings changes, withdrawal processing).
 * Records are never updated or deleted from application code.
 */
const auditLogSchema = new mongoose.Schema(
  {
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
      index: true
    },
    actorName: { type: String, default: '' },
    actorRole: { type: String, default: '' },

    // e.g. wallet_settings_update, withdrawal_approve, wallet_manual_credit
    action: { type: String, required: true, index: true },

    entityType: { type: String, default: '' }, // WithdrawalRequest, AppSettings, AdminWalletTransaction...
    entityId: { type: String, default: '' },

    // The reporter/admin affected by this action (if any)
    targetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
      index: true
    },
    targetName: { type: String, default: '' },

    description: { type: String, default: '' },

    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },

    ip: { type: String, default: '' }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
