const mongoose = require('mongoose');

/**
 * One reporter app login attempt (success or failure). Append-only; kept a year.
 * Feeds the Reporter Security page ("where / from what did this account log in")
 * and — from Phase 2 — the device and GPS fields.
 */
const reporterLoginEventSchema = new mongoose.Schema({
  adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  username: { type: String, default: '' },
  role: { type: String, default: '' },
  success: { type: Boolean, default: false },
  reason: { type: String, default: '' }, // ok | bad_password | no_account | inactive | not_approved | role
  source: { type: String, default: 'app' },
  ip: { type: String, default: '' },
  city: { type: String, default: '' },
  region: { type: String, default: '' },
  country: { type: String, default: '' },
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  userAgent: { type: String, default: '' },
  // Phase 2 (app update): device + GPS. Empty for older app versions.
  deviceId: { type: String, default: '' },
  deviceModel: { type: String, default: '' },
  appVersion: { type: String, default: '' },
  at: { type: Date, default: Date.now },
});

reporterLoginEventSchema.index({ adminId: 1, at: -1 });
reporterLoginEventSchema.index({ at: -1 });
reporterLoginEventSchema.index({ ip: 1, at: -1 });
reporterLoginEventSchema.index({ at: 1 }, { expireAfterSeconds: 365 * 24 * 3600 });

module.exports = mongoose.model('ReporterLoginEvent', reporterLoginEventSchema);
