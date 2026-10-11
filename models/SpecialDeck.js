'use strict';

/**
 * "Special deck" — the admin-curated stack the main app opens with a LEFT swipe
 * on the news feed (3D cube turn). One document per language. Each card is
 * either a hand-picked news story, the daily quiz, "Where is my train", an
 * existing advertisement, or a free banner (image + link).
 *
 * Additive & production-safe: the app shows the deck ONLY when `enabled` is
 * true for that language AND at least one card resolves; otherwise the left
 * swipe does nothing and the feed behaves exactly as before.
 */
const mongoose = require('mongoose');

const CARD_TYPES = ['news', 'quiz', 'train', 'ad', 'banner'];

// A clickable rectangle drawn on a banner image (image-map). Coordinates are
// normalised 0..1 so they scale to any rendered size. Same shape as the reporter
// join-popup hotspots, but the tap target here is always a link.
const hotspotSchema = new mongoose.Schema(
  {
    x: { type: Number, default: 0, min: 0, max: 1 },
    y: { type: Number, default: 0, min: 0, max: 1 },
    w: { type: Number, default: 0, min: 0, max: 1 },
    h: { type: Number, default: 0, min: 0, max: 1 },
    linkUrl: { type: String, default: '' }, // http… or app://quiz|train|games|viral…
    label: { type: String, default: '' }, // admin note (not shown to users)
  },
  { _id: false }
);

const cardSchema = new mongoose.Schema(
  {
    order: { type: Number, default: 1 },
    type: { type: String, enum: CARD_TYPES, default: 'banner' },
    enabled: { type: Boolean, default: true }, // per-card switch
    newsId: { type: String, default: '' }, // type=news → News._id
    adId: { type: String, default: '' }, // type=ad → Ad._id
    title: { type: String, default: '' }, // quiz / train / banner overlay text
    subtitle: { type: String, default: '' },
    imageUrl: { type: String, default: '' }, // quiz / train / banner background
    linkUrl: { type: String, default: '' }, // banner whole-card tap target (used when no hotspots)
    // Banner only: multiple clickable regions, each with its own link. When
    // present they take priority over the whole-card linkUrl.
    hotspots: { type: [hotspotSchema], default: [] },
    aspectRatio: { type: Number, default: 0 }, // banner image width/height, so the app shows it uncropped
  },
  { _id: false }
);

const specialDeckSchema = new mongoose.Schema(
  {
    language: { type: String, required: true, unique: true, lowercase: true, trim: true },
    enabled: { type: Boolean, default: false }, // per-language flag (default OFF)
    cards: { type: [cardSchema], default: [] },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: '' },
  },
  { minimize: false }
);

const SpecialDeck = mongoose.models.SpecialDeck || mongoose.model('SpecialDeck', specialDeckSchema);
SpecialDeck.CARD_TYPES = CARD_TYPES;
module.exports = SpecialDeck;
