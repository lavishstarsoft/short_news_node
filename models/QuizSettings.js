'use strict';

const mongoose = require('mongoose');

/**
 * QuizSettings — Single source of truth for Daily Quiz configuration.
 * Replaces global AppSettings quiz properties to make the quiz domain self-contained.
 */
const quizSettingsSchema = new mongoose.Schema({
  // Force a single document using a constant key
  key: { type: String, required: true, unique: true, default: 'quiz_config' },
  
  // Master ON/OFF switch for the daily quiz
  isEnabled: { type: Boolean, default: false },
  
  // Explicit list of allowed languages (e.g., ['te', 'en']). Empty means NO languages.
  enabledLanguages: { type: [String], default: [] },
  
  // Track who last modified the settings
  updatedByName: { type: String, default: 'system' }
}, { timestamps: true });

module.exports = mongoose.model('QuizSettings', quizSettingsSchema);
