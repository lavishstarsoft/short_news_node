const mongoose = require('mongoose');

/**
 * AuthShadowLog — lightweight, BOUNDED shadow-authorization observation log.
 *
 * Phase-0 Step-3 (shadow mode). The new permission layer never enforces; it only
 * CALCULATES a decision and, when it disagrees with the (authoritative) existing
 * authorization, records one compact row here for later review. Deliberately kept
 * OUT of AuditLog so it can never pollute the real audit trail.
 *
 * Capped collection → fixed max size, oldest rows auto-evicted, negligible storage
 * and write cost. Contains NO secrets, NO request bodies, NO query strings; the
 * `route` is the express PATTERN (e.g. /admin/api/wallet-adjustment), not a URL
 * with real ids.
 */
const authShadowLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    role: { type: String, default: '' },
    route: { type: String, default: '' },
    method: { type: String, default: '' },
    permission: { type: String, default: '' },
    requiredScope: { type: String, default: '' },
    newDecision: { type: String, default: '' },   // ALLOW | DENY | UNKNOWN
    comparison: { type: String, default: '' },     // MATCH | MISMATCH | UNKNOWN
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    capped: { size: 5 * 1024 * 1024, max: 100000 }, // ~5MB / 100k rows, whichever first
  }
);

module.exports = mongoose.model('AuthShadowLog', authShadowLogSchema);
