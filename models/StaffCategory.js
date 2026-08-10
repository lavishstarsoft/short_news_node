const mongoose = require('mongoose');

/**
 * StaffCategory — admin-managed list of Display Roles for staff (editors/reporters).
 *
 * Replaces the old free-text `Admin.displayRole` input with a controlled, editable
 * vocabulary. This is a DISPLAY label only — it never affects the auth `role` enum
 * (editor/subeditor). Disabling (isActive:false) hides a category from new pickers
 * without breaking existing users who already carry that displayRole value.
 *
 * `pdfEligible` gates the "Official Staff Record" PDF button (Sub Editor / Bureau
 * by default).
 */
const staffCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
      unique: true // the human label stored on Admin.displayRole
    },
    isActive: {
      type: Boolean,
      default: true // false => hidden from new pickers, existing users untouched
    },
    pdfEligible: {
      type: Boolean,
      default: false // true => Official Staff Record PDF button is shown
    },
    sortOrder: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

// Case-insensitive lookup so "Bureau"/"bureau" resolve to the same category.
staffCategorySchema.index({ name: 1 });

/**
 * Seed the default categories exactly once (idempotent). Safe to call on every
 * page load — only inserts the ones that are missing, never overrides admin edits.
 */
staffCategorySchema.statics.seedDefaults = async function seedDefaults() {
  const defaults = [
    { name: 'Sub Editor', pdfEligible: true, sortOrder: 1 },
    { name: 'Bureau', pdfEligible: true, sortOrder: 2 },
    { name: 'Reporter', pdfEligible: false, sortOrder: 3 },
    { name: 'District Reporter', pdfEligible: false, sortOrder: 4 },
    { name: 'Stringer', pdfEligible: false, sortOrder: 5 }
  ];
  const ops = defaults.map((d) => ({
    updateOne: {
      filter: { name: d.name },
      update: { $setOnInsert: d }, // never clobber an admin's later edits
      upsert: true
    }
  }));
  try {
    await this.bulkWrite(ops, { ordered: false });
  } catch (e) {
    // Unique-collision on a concurrent seed is harmless.
    if (e && e.code !== 11000) throw e;
  }
};

module.exports = mongoose.model('StaffCategory', staffCategorySchema);
