'use strict';

/**
 * QuizEntry — one document per (user, week, day). Merges the server-assigned
 * question and the user's frozen answer. Unique {userId, weekId, dayKey} guarantees
 * one question + one locked answer per user per day. userId = server-verified
 * googleId (stable across devices), never client-trusted.
 */
const mongoose = require('mongoose');

const quizEntrySchema = new mongoose.Schema({
  userId: { type: String, required: true },     // verified googleId
  weekId: { type: String, required: true },
  dayKey: { type: String, required: true },
  dayIndex: { type: Number, required: true },   // 1..6 (Mon..Sat)
  questionId: { type: mongoose.Schema.Types.ObjectId, ref: 'QuizQuestion', required: true },
  assignedAt: { type: Date, default: Date.now },
  selectedOption: { type: String, default: null },  // A..D
  isCorrect: { type: Boolean, default: null },
  submittedAt: { type: Date, default: null },
}, { timestamps: true });

quizEntrySchema.index({ userId: 1, weekId: 1, dayKey: 1 }, { unique: true });
quizEntrySchema.index({ weekId: 1, userId: 1 });

module.exports = mongoose.model('QuizEntry', quizEntrySchema);
