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

  // Hour of the IST day (0–23) at which the DAILY quiz question rolls over to the
  // next one. Default 10 = the new question appears at 10:00 AM IST (instead of
  // midnight). The whole day/week boundary shifts to this hour. Admin-controlled.
  dayRolloverHour: { type: Number, default: 10, min: 0, max: 23 },

  // Feed position for users who have NOT played today: the Quiz card repeats after
  // every this-many news cards (1 = after the 1st). Admin-controlled, like ad placement.
  feedPosition: { type: Number, default: 1, min: 1 },

  // Feed position for users who HAVE already submitted today's answer — usually a
  // larger number so the card appears less often for them. Falls back to feedPosition
  // when unset (0/null) for backward compatibility.
  feedPositionPlayed: { type: Number, default: 7, min: 1 },

  // ── Quiz promo BANNER (ad-style image shown in the app feed) ──
  // Full image the app displays; tapping anywhere on it opens the quiz.
  bannerImageUrl: { type: String, default: '' },
  // When false the app falls back to its built-in banner asset.
  bannerEnabled: { type: Boolean, default: true },

  // ── Sign-in page full image (tap → sign in) + Terms & Conditions text ──
  // A separate full-screen image shown on the quiz sign-in page. When empty the
  // app keeps its built-in sign-in design.
  signinImageUrl: { type: String, default: '' },
  // Terms & Conditions shown in a popup from the sign-in page (admin-editable).
  termsText: { type: String, default: '' },

  // The "Sign In to Play" tap area WITHIN the sign-in image, stored as FRACTIONS
  // (0..1) of the image so it maps to the same spot on every device size. When
  // w/h are 0 the app treats the whole image as tappable (backward-safe).
  signinButtonRect: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    w: { type: Number, default: 0 },
    h: { type: Number, default: 0 },
  },

  // "Complete Profile" full image (shown when profile is incomplete) + the tap
  // area for its button (fractions 0..1). Empty → app keeps its built-in design.
  profileImageUrl: { type: String, default: '' },
  profileButtonRect: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    w: { type: Number, default: 0 },
    h: { type: Number, default: 0 },
  },

  // Track who last modified the settings
  updatedByName: { type: String, default: 'system' }
}, { timestamps: true });

module.exports = mongoose.model('QuizSettings', quizSettingsSchema);
