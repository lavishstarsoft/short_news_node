'use strict';

const mongoose = require('mongoose');

const inAppPopupSchema = new mongoose.Schema({
  language: { type: String, required: true, index: true, trim: true },
  title: { type: String, required: true, trim: true },
  message: { type: String, default: '', trim: true },
  imageUrl: { type: String, default: '', trim: true },
  buttonText: { type: String, default: '', trim: true },
  actionUrl: { type: String, default: '', trim: true },
  isActive: { type: Boolean, default: false },
  triggerAfterSwipes: { type: Number, default: 3, min: 1 },
}, { timestamps: true });

module.exports = mongoose.model('InAppPopup', inAppPopupSchema);
