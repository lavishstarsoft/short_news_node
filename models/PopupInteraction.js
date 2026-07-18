const mongoose = require('mongoose');

const popupInteractionSchema = new mongoose.Schema(
  {
    popupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ReporterPopup',
      required: true
    },
    reporterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      required: true
    },
    action: {
      type: String,
      enum: ['viewed', 'dismissed'],
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

// Add unique compound index for popup and reporter to easily check status
// Actually, since a popup can be 'viewed' multiple times or 'dismissed' (and later re-shown if frequency is 'daily'), 
// we should just index them for fast querying rather than enforcing uniqueness.
popupInteractionSchema.index({ popupId: 1, reporterId: 1, action: 1, timestamp: -1 });
popupInteractionSchema.index({ reporterId: 1 });

module.exports = mongoose.model('PopupInteraction', popupInteractionSchema);
