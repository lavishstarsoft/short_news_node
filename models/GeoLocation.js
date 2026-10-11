const mongoose = require('mongoose');

/**
 * India-wide administrative geography (LGD / Census 2011): state → district →
 * mandal (sub-district) → village.
 *
 * This is a SEPARATE, ADDITIVE collection ("geolocations"). It deliberately does
 * NOT touch the existing `Location` model (which powers the news location/scope
 * business logic) — village data is ~6.6 lakh rows with duplicate names across
 * districts, which the strict `Location` schema can't hold. Use this only for the
 * reporter district → mandal → village pickers / search.
 *
 * Source: planemad/india-local-government-directory (mirror of lgdirectory.gov.in).
 * Seed with scripts/geo-data/seed-geo.js.
 */
const geoLocationSchema = new mongoose.Schema(
  {
    // Level of this row.
    type: {
      type: String,
      enum: ['state', 'district', 'mandal', 'village'],
      required: true,
    },

    name: { type: String, required: true }, // English name (100% present; search runs on this)

    // LGD code for this row (unique within its type).
    code: { type: String, required: true },

    // Lowercased English name — what prefix/substring search runs against.
    search: { type: String, required: true },

    // Denormalised ancestry so a village/mandal search can filter by district
    // (or state) in one indexed query, without joins.
    stateCode: { type: String, default: '' },
    stateName: { type: String, default: '' },
    districtCode: { type: String, default: '' },
    districtName: { type: String, default: '' },
    mandalCode: { type: String, default: '' }, // sub-district
    mandalName: { type: String, default: '' },

    // Village only: "Inhabitant" / "Uninhabited" etc. (uninhabited ones are skipped by default in search).
    status: { type: String, default: '' },
  },
  { timestamps: true }
);

// One row per (type, LGD code).
geoLocationSchema.index({ type: 1, code: 1 }, { unique: true });
// Village autocomplete inside a reporter's district (the main query).
geoLocationSchema.index({ type: 1, districtCode: 1, search: 1 });
// Optional tighter scope by mandal, and by state.
geoLocationSchema.index({ type: 1, mandalCode: 1, search: 1 });
geoLocationSchema.index({ type: 1, stateCode: 1, search: 1 });
// List children of a parent (district's mandals, mandal's villages, etc.).
geoLocationSchema.index({ districtCode: 1, type: 1 });

module.exports = mongoose.models.GeoLocation || mongoose.model('GeoLocation', geoLocationSchema);
