'use strict';

const mongoose = require('mongoose');

// Single-document config for News-in-AR: which news cards show the 👓 AR button.
// showOnAll=true → every news card; otherwise ONLY the news in enabledNewsIds.
const arNewsConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'config', unique: true },
  showOnAll: { type: Boolean, default: false },
  enabledNewsIds: { type: [String], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('ArNewsConfig', arNewsConfigSchema);
