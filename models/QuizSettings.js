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

  // IST time (HH:mm) on SATURDAY when correct answers are revealed for the whole
  // week (green/red). Before this, submitted answers stay neutral & hidden.
  revealTime: { type: String, default: '23:30' },

  // IST time (HH:mm) on SUNDAY when the 10 weekly winners become visible in the app.
  winnerReleaseTime: { type: String, default: '10:00' },

  // Feed position for users who have NOT played today: the Quiz card repeats after
  // every this-many news cards (1 = after the 1st). Admin-controlled, like ad placement.
  feedPosition: { type: Number, default: 1, min: 1 },

  // Feed position for users who HAVE already submitted today's answer — usually a
  // larger number so the card appears less often for them. Falls back to feedPosition
  // when unset (0/null) for backward compatibility.
  feedPositionPlayed: { type: Number, default: 7, min: 1 },

  // Track who last modified the settings
  updatedByName: { type: String, default: 'system' }
}, { timestamps: true });

module.exports = mongoose.model('QuizSettings', quizSettingsSchema);
