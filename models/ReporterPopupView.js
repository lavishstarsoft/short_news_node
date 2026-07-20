const mongoose = require('mongoose');

/**
 * Popup view/dismiss history per reporter.
 * popupId + reporterId unique — duplicates ravu (multi-tab / refresh safe).
 */
const reporterPopupViewSchema = new mongoose.Schema({
  popupId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReporterPopup', required: true },
  reporterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },

  viewCount: { type: Number, default: 0 },
  firstSeenAt: { type: Date, default: null },
  lastSeenAt: { type: Date, default: null },
  dismissedAt: { type: Date, default: null },
  clickedAt: { type: Date, default: null }
}, { timestamps: true });

reporterPopupViewSchema.index({ popupId: 1, reporterId: 1 }, { unique: true });
reporterPopupViewSchema.index({ reporterId: 1 });

module.exports = mongoose.model('ReporterPopupView', reporterPopupViewSchema);
