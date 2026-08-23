'use strict';

/**
 * QuizTestOverride — per-user (googleId) admin test-mode flag for the Daily Quiz.
 * When active, that ONE user's quiz APIs simulate the chosen weekday (Mon..Sun) of
 * the fixed test week. Real users (no override) are completely unaffected. This is
 * a session/preference flag only — it never changes real dates, entries, or winners.
 */
const mongoose = require('mongoose');

const quizTestOverrideSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true }, // target app user (googleId)
  simDayIndex: { type: Number, default: 1 },              // 1=Mon..6=Sat, 7=Sun
  active: { type: Boolean, default: true },
  updatedByName: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('QuizTestOverride', quizTestOverrideSchema);
