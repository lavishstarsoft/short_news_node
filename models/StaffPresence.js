const mongoose = require('mongoose');

/**
 * What the "Tehelka Incharge" app reports about one State In-Charge's phone.
 *
 * TWO collections on purpose:
 *  • StaffPresence — ONE document per person, always the latest. The live map
 *    and the "who is online" list read this, so those stay fast however long
 *    the history grows.
 *  • StaffPresenceLog — the history, capped by a TTL. This is what answers
 *    "they said the signal was weak at 3 p.m. — was it?", which is the whole
 *    reason the owner asked for signal reporting.
 *
 * Nothing here is written unless the In-Charge is signed into that app.
 */

const DUTY = ['on', 'off'];

/** Signal is reported as Android's 0–4 bars, because that is what the user sees. */
const signalSchema = new mongoose.Schema({
  bars: { type: Number, default: null, min: 0, max: 4 },
  dbm: { type: Number, default: null },
  network: { type: String, default: '' },   // wifi | mobile | none
  carrier: { type: String, default: '' },
  wifi: { type: Boolean, default: false },
}, { _id: false });

const gpsSchema = new mongoose.Schema({
  lat: { type: Number, default: null },
  lng: { type: Number, default: null },
  accuracy: { type: Number, default: null },
  /** True when Android says the fix came from a fake-location app. */
  mock: { type: Boolean, default: false },
  at: { type: Date, default: null },
}, { _id: false });

const presenceFields = {
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
  staffName: { type: String, default: '' },

  /** The In-Charge's own on/off duty switch. GPS is only collected while 'on'. */
  duty: { type: String, enum: DUTY, default: 'off', index: true },
  /** foreground | background | killed — how the app was when this was sent. */
  appState: { type: String, default: '' },

  gps: { type: gpsSchema, default: () => ({}) },
  signal: { type: signalSchema, default: () => ({}) },
  batteryPercent: { type: Number, default: null, min: 0, max: 100 },
  batteryCharging: { type: Boolean, default: false },
  /** Android's battery saver, which is itself a reason the service died. */
  powerSaveMode: { type: Boolean, default: false },

  deviceId: { type: String, default: '' },
  deviceModel: { type: String, default: '' },
  appVersion: { type: String, default: '' },
  ip: { type: String, default: '' },

  /**
   * Set when the phone is NOT set up for reliable tracking (autostart off or
   * battery optimisation on). Without this the desk cannot tell "not working"
   * from "phone is throttling the app", which on Xiaomi/Oppo is the usual cause.
   */
  setupWarnings: { type: [String], default: [] },

  at: { type: Date, default: Date.now, index: true },
};

const staffPresenceSchema = new mongoose.Schema({
  ...presenceFields,
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, unique: true },
  /** Last time anything at all arrived — "online" is measured from this. */
  lastSeenAt: { type: Date, default: Date.now, index: true },
  dutyChangedAt: { type: Date, default: null },
}, { timestamps: true });

const staffPresenceLogSchema = new mongoose.Schema({
  ...presenceFields,
}, { timestamps: false });

// 30 days of history is enough to settle any argument about a given day.
staffPresenceLogSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });
staffPresenceLogSchema.index({ staffId: 1, at: -1 });

const StaffPresence = mongoose.model('StaffPresence', staffPresenceSchema);
const StaffPresenceLog = mongoose.model('StaffPresenceLog', staffPresenceLogSchema);

module.exports = StaffPresence;
module.exports.StaffPresence = StaffPresence;
module.exports.StaffPresenceLog = StaffPresenceLog;
module.exports.DUTY = DUTY;
