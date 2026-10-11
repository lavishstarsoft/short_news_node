'use strict';

/**
 * "Earn extra income" advertise page — the in-app landing page opened when a
 * guest taps the 2nd (advertise) card in the Reporter Hub. One document per
 * language. Fully admin-authored: a banner image with OVERLAY text typed by the
 * admin, a stack of content blocks, and a call-to-action button.
 *
 * Additive & production-safe: the app shows this page only when `enabled` is
 * true for the language; otherwise the card keeps its previous behaviour.
 */
const mongoose = require('mongoose');

/** One content block. `type` decides how the app renders `text` / `items`. */
const blockSchema = new mongoose.Schema(
  {
    order: { type: Number, default: 1 },
    type: { type: String, default: 'paragraph' }, // paragraph | heading | highlight | bullets
    text: { type: String, default: '' }, // paragraph / heading / highlight body
    items: { type: [String], default: [] }, // bullets
  },
  { _id: false }
);

const advertisePageSchema = new mongoose.Schema(
  {
    language: { type: String, required: true, unique: true, lowercase: true, trim: true },
    enabled: { type: Boolean, default: false }, // per-language flag (default OFF)
    banner: {
      imageUrl: { type: String, default: '' },
      title: { type: String, default: '' }, // overlay heading (admin-typed)
      subtitle: { type: String, default: '' }, // small line under the title
      overlaySide: { type: String, default: 'right' }, // right | left | bottom — where text/dark gradient sits
    },
    blocks: { type: [blockSchema], default: [] },
    cta: {
      label: { type: String, default: '' },
      action: { type: String, default: 'whatsapp' }, // whatsapp | url | none
      value: { type: String, default: '' }, // number / URL
    },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: '' },
  },
  { minimize: false }
);

module.exports =
  mongoose.models.ReporterAdvertisePage || mongoose.model('ReporterAdvertisePage', advertisePageSchema);
