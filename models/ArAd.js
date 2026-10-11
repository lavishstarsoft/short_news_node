'use strict';

const mongoose = require('mongoose');

// A sponsored AR (augmented-reality) ad. A shop/sponsor gives a 3D model (.glb)
// of their product; the app shows an "👓 View in AR" badge on chosen news cards,
// and tapping it opens Google Scene Viewer so the reader can place the product
// in their own room, then tap a Call / WhatsApp / Shop button. The owner charges
// the sponsor per slot and sees impressions / AR-opens / taps here.
//
// Fully additive + isolated — nothing here touches the 3D-cube ad model.
const arAdSchema = new mongoose.Schema({
  title: { type: String, required: true },         // internal label
  sponsorName: { type: String, default: '' },      // shown as "Sponsored by …"

  glbUrl: { type: String, required: true },        // the 3D model placed in AR
  posterImageUrl: { type: String, default: '' },   // thumbnail shown on the card
  caption: { type: String, default: '' },          // e.g. "మీ ఇంట్లో చూడండి"

  // Call to action after viewing in AR.
  ctaLabel: { type: String, default: 'Shop now' },
  ctaType: { type: String, enum: ['url', 'call', 'whatsapp', 'none'], default: 'url' },
  ctaValue: { type: String, default: '' },         // link / phone number
  priceInfo: { type: String, default: '' },        // optional, e.g. "₹2,999"

  // Which news cards carry this AR badge. Empty = none pinned.
  displayNewsIds: { type: [String], default: [], index: true },
  language: { type: String, default: '' },         // '' = all languages
  isActive: { type: Boolean, default: false },     // OFF by default — safety

  // Revenue / performance counters (incremented from the app).
  stats: {
    impressions: { type: Number, default: 0 },     // card shown with the AR badge
    arOpens: { type: Number, default: 0 },         // reader opened the AR view
    ctaTaps: { type: Number, default: 0 },         // reader tapped Call / Shop
  },

  // Billing (internal only — never sent to the app).
  billAmount: { type: Number, default: 0 },        // what the sponsor pays
  billNote: { type: String, default: '' },

  author: { type: String, default: '' },
  authorId: { type: String, default: '' },
}, { timestamps: true });

arAdSchema.index({ isActive: 1, updatedAt: -1 });

module.exports = mongoose.model('ArAd', arAdSchema);
