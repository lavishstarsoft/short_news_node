const mongoose = require('mongoose');

/**
 * "Join as a Reporter" popup — an admin-managed IMAGE with clickable hotspot
 * regions (image-map). Guests see the image; tapping a region navigates (login /
 * register / url / close). Coordinates are normalised 0..1 fractions of the image
 * so they scale correctly on any screen. Single active config (singleton).
 */
const hotspotSchema = new mongoose.Schema({
  x: { type: Number, required: true, min: 0, max: 1 },
  y: { type: Number, required: true, min: 0, max: 1 },
  w: { type: Number, required: true, min: 0, max: 1 },
  h: { type: Number, required: true, min: 0, max: 1 },
  action: { type: String, enum: ['login', 'register', 'url', 'close'], default: 'login' },
  url: { type: String, default: '', trim: true },   // only for action='url'
  label: { type: String, default: '', trim: true },  // admin note (not shown to users)
}, { _id: false });

const reporterJoinPopupSchema = new mongoose.Schema({
  // Singleton key — there is only one join popup config.
  key: { type: String, default: 'default', unique: true, index: true },
  imageUrl: { type: String, default: '', trim: true },
  // width / height of the uploaded image, so the app renders the exact aspect ratio.
  aspectRatio: { type: Number, default: 0.75 }, // width/height (e.g. 1024/1365 ≈ 0.75)
  hotspots: { type: [hotspotSchema], default: [] },
  isActive: { type: Boolean, default: false },
  updatedByName: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('ReporterJoinPopup', reporterJoinPopupSchema);
