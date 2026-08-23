'use strict';

/**
 * QuizWeek — one document per Monday-based IST week. Created lazily on first quiz
 * activity. status transitions: active → closed (Sat passed) → winners_selected.
 * The 'closed' → 'winners_selected' flip is the one-time gate for winner selection.
 */
const mongoose = require('mongoose');

const quizWeekSchema = new mongoose.Schema({
  weekId: { type: String, required: true, unique: true },       // Monday IST date key
  startDate: { type: String, required: true },                  // Monday
  endDate: { type: String, required: true },                    // Saturday
  sundayDate: { type: String, required: true },                 // Sunday
  status: { type: String, enum: ['active', 'closed', 'winners_selected'], default: 'active' },
}, { timestamps: true });

quizWeekSchema.index({ status: 1 });

module.exports = mongoose.model('QuizWeek', quizWeekSchema);
