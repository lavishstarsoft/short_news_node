const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * AgreementAcceptance — IMMUTABLE, append-only legal record of a State In-Charge
 * accepting a specific T&C version. Once created it can NEVER be updated or deleted
 * (schema-level guards below + no update/delete route). Tamper-evidence via a
 * SHA-256 hash chain (acceptanceHash includes previousHash).
 *
 * It stores the ACCEPTED T&C version + hash verbatim, so publishing a newer T&C
 * never alters an existing acceptance (CURRENT T&C ≠ OLD ACCEPTED T&C).
 *
 * IP / device / GPS are CORROBORATING audit evidence only — never identity proof.
 */
const acceptanceSchema = new mongoose.Schema(
  {
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    designation: { type: String, default: '' },
    state: { type: String, default: '' },

    // Exactly which T&C was accepted (frozen copy of version + hash).
    tncVersion: { type: String, required: true },
    tncHash: { type: String, required: true },

    acceptedAt: { type: Date, required: true },
    otpVerified: { type: Boolean, default: false },
    typedName: { type: String, default: '' },
    signatureRef: { type: String, default: '' }, // R2 key of drawn signature (optional)

    // Corroborating evidence (NOT identity proof).
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    deviceMetadata: { type: mongoose.Schema.Types.Mixed, default: null },
    locationPermission: { type: String, enum: ['granted', 'denied', 'unavailable'], default: 'unavailable' },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },

    // Tamper-evident chain.
    previousHash: { type: String, default: '' },
    acceptanceHash: { type: String, default: '', index: true },
    workerId: { type: String, default: '' }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

/** Deterministic hash of the acceptance facts + the previous record's hash. */
acceptanceSchema.statics.computeHash = function (fields, previousHash) {
  const canonical = [
    fields.adminId, fields.tncVersion, fields.tncHash,
    new Date(fields.acceptedAt).toISOString(), fields.ip || '', fields.typedName || '',
    fields.otpVerified ? '1' : '0', previousHash || ''
  ].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

// APPEND-ONLY: forbid every mutation/deletion path at the schema level.
['findOneAndUpdate', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'findByIdAndUpdate', 'findByIdAndDelete', 'replaceOne'].forEach((op) => {
  acceptanceSchema.pre(op, function (next) {
    next(new Error(`AgreementAcceptance is append-only — ${op} is not permitted.`));
  });
});
acceptanceSchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('AgreementAcceptance is immutable — cannot be modified after creation.'));
  next();
});

module.exports = mongoose.model('AgreementAcceptance', acceptanceSchema);
