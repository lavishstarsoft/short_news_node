'use strict';
const mongoose = require('mongoose');

// Singleton doc: the first-page "India coverage" card is now a ready-made image
// the admin uploads PER LANGUAGE (no dynamic map). Additive & isolated.
const coverageMapSchema = new mongoose.Schema({
  images: [
    {
      language: { type: String },   // language code (te/hi/ta/… — dynamic)
      imageUrl: { type: String },
      _id: false,
    },
  ],
  isActive: { type: Boolean, default: true },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('CoverageMap', coverageMapSchema);
