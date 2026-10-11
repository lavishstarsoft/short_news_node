'use strict';

/**
 * Train Promo Banner — the single admin-managed banner shown UNDER "Search
 * history" on the app's "Where is my train" page (replaces the static "Travel
 * Smarter with Tehelka Rail" card). Admin uploads an image and draws clickable
 * "hotspot" rectangles, each with its own link. Additive; `enabled` default OFF
 * so the app keeps its static card until an admin turns this on.
 *
 * Single global document (key: 'default'). Mirrors the Special Deck banner-
 * hotspot shape (coords normalised 0..1 so they scale to any rendered size).
 */
const mongoose = require('mongoose');

const hotspotSchema = new mongoose.Schema(
  {
    x: { type: Number, default: 0, min: 0, max: 1 },
    y: { type: Number, default: 0, min: 0, max: 1 },
    w: { type: Number, default: 0, min: 0, max: 1 },
    h: { type: Number, default: 0, min: 0, max: 1 },
    linkUrl: { type: String, default: '' }, // http… or app://quiz|train|games|viral…
    label: { type: String, default: '' }, // admin note (never sent to users)
  },
  { _id: false }
);

const trainPromoBannerSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true, index: true }, // single doc
    enabled: { type: Boolean, default: false }, // OFF → app shows its static card
    imageUrl: { type: String, default: '' },
    aspectRatio: { type: Number, default: 0 }, // image width/height, so the app shows it uncropped
    title: { type: String, default: '' }, // optional (not shown when using an image)
    subtitle: { type: String, default: '' },
    linkUrl: { type: String, default: '' }, // whole-banner tap link (used only when no hotspots)
    hotspots: { type: [hotspotSchema], default: [] },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: '' },
  },
  { collection: 'train_promo_banners' }
);

module.exports = mongoose.model('TrainPromoBanner', trainPromoBannerSchema);
