'use strict';
const mongoose = require('mongoose');

// One face of the dice: an image + where tapping that face goes.
const faceSchema = new mongoose.Schema({
  imageUrl: { type: String, default: '' },
  targetType: { type: String, enum: ['news', 'games', 'train', 'quiz', 'viral', 'url', 'meta', 'none'], default: 'none' },
  targetValue: { type: String, default: '' }, // URL / newsId / etc.
  label: { type: String, default: '' },
}, { _id: false });

// A full-page, finger-rotatable 3D dice shown in the feed. Fully dashboard-driven.
const dicePageSchema = new mongoose.Schema({
  title: { type: String, required: true },      // internal label
  faces: { type: [faceSchema], default: [] },   // up to 6 (front,right,back,left,top,bottom)
  everyNCards: { type: Number, default: 8, min: 2, max: 100 }, // inject once per N news cards
  language: { type: String, default: '' },      // '' = all languages, else code (te/hi/...)
  isActive: { type: Boolean, default: false },  // OFF by default — safety
}, { timestamps: true });

dicePageSchema.index({ isActive: 1, updatedAt: -1 });
module.exports = mongoose.model('DicePage', dicePageSchema);
