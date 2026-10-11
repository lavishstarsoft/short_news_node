const mongoose = require('mongoose');

/**
 * Reporter security switches (Super Admin → /admin/reporter-security). One document.
 * Every RULE defaults OFF so turning the feature on is a deliberate choice; passive
 * record-keeping (app login history, who created an account) is always on.
 */
const reporterSecuritySettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'reporter_security', unique: true },
  /** Same UPI / bank / mobile as another reporter account → withdrawal held for Super Admin. */
  payoutLinkHold: { type: Boolean, default: false },
  /** A State In-Charge may not approve news of a reporter they proposed as stringer / in-charge. */
  sicSelfApprovalBlock: { type: Boolean, default: false },
  /** …only while that proposal is younger than this many days (0 = always). */
  sicSelfApprovalWindowDays: { type: Number, default: 30, min: 0, max: 3650 },
  /** App login refused for accounts that self-registered and were never approved. */
  blockUnapprovedAppLogin: { type: Boolean, default: false },
  /** Reporter web portal (GraphQL loginEditor / registerEditor) closed. */
  closeReporterPortal: { type: Boolean, default: false },
  /** Brute-force limit on the app's reporter login. */
  reporterLoginRateLimit: { type: Boolean, default: false },

  // ── Phase 2 (needs the updated app) ──
  /** One device per reporter / State In-Charge: a new login logs the old device out. */
  singleDeviceLogin: { type: Boolean, default: false },
  /** …and refuse tokens issued before sessions existed (turn on only after everyone updated). */
  singleDeviceStrict: { type: Boolean, default: false },
  /** News can only be filed with GPS from the phone. */
  requireGpsOnNews: { type: Boolean, default: false },
  /** Reporters must update the app: minimum allowed appVersion (empty = no gate). */
  minReporterAppVersion: { type: String, default: '' },
  updatedBy: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('ReporterSecuritySettings', reporterSecuritySettingsSchema);
