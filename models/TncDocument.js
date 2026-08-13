const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * TncDocument — versioned Terms & Conditions for the State In-Charge agreement.
 *
 * Lifecycle:  draft → published → (archived when a newer version is published)
 *  - DRAFT: freely editable by Super Admin.
 *  - PUBLISHED: content is FROZEN. contentHash is computed at publish time from the
 *    exact English+Telugu body and can never change. To alter terms, create a NEW
 *    version — an accepted agreement always points at the exact version it accepted,
 *    so old acceptances stay legally intact even after a new publish.
 *
 * Immutability is enforced here (pre-save guard) AND at the controller (no edit
 * route for a published doc).
 */
const tncSchema = new mongoose.Schema(
  {
    version: { type: String, required: true, unique: true, trim: true }, // e.g. "1.0", "1.1"
    title: { type: String, default: 'State In-Charge Appointment — Terms & Conditions' },
    bodyEnglish: { type: String, default: '' },
    bodyTelugu: { type: String, default: '' },
    // SHA-256 of the exact published content (set at publish; never changes after).
    contentHash: { type: String, default: '' },
    status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft', index: true },
    effectiveFrom: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    changeSummary: { type: String, default: '' }
  },
  { timestamps: true }
);

/** Canonical SHA-256 over the exact content that is being published. */
tncSchema.statics.computeHash = function (version, en, te) {
  return crypto.createHash('sha256')
    .update(`v=${version}\n--EN--\n${en || ''}\n--TE--\n${te || ''}`)
    .digest('hex');
};

// Guard: once PUBLISHED, the legal content (body/hash/version) must never be mutated.
tncSchema.pre('save', function (next) {
  if (this.isNew) return next();
  if (this.status === 'published' && !this.isModified('status')) {
    const frozen = ['bodyEnglish', 'bodyTelugu', 'contentHash', 'version'];
    if (frozen.some((f) => this.isModified(f))) {
      return next(new Error('Published T&C is immutable — create a new version instead.'));
    }
  }
  next();
});
// Block bulk update/delete routes on this collection entirely.
['findOneAndUpdate', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'findOneAndDelete'].forEach((op) => {
  tncSchema.pre(op, function (next) {
    next(new Error(`Direct ${op} on TncDocument is not allowed — use the controlled publish flow.`));
  });
});

module.exports = mongoose.model('TncDocument', tncSchema);
