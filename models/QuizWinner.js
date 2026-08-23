'use strict';

/**
 * QuizWinner — the frozen 10 winners for a week. Immutable once written. Unique
 * {weekId,rank} and {weekId,userId} prevent duplicates/reselection. ₹1,000 is paid
 * manually outside the system — this is a record only (no wallet integration).
 */
const mongoose = require('mongoose');

const quizWinnerSchema = new mongoose.Schema({
  weekId: { type: String, required: true },
  rank: { type: Number, required: true, min: 1, max: 10 },
  userId: { type: String, required: true },       // verified googleId
  displayName: { type: String, default: '' },
  score: { type: Number, default: 0 },            // correct answers that week
  answered: { type: Number, default: 0 },
  mode: { type: String, enum: ['random_lottery', 'admin_select'], required: true },
  isTest: { type: Boolean, default: false }, // admin test-mode winners (never real payouts)
  selectedById: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  selectedByName: { type: String, default: '' },
  selectedAt: { type: Date, default: Date.now },
}, { timestamps: true });

quizWinnerSchema.index({ weekId: 1, rank: 1 }, { unique: true });
quizWinnerSchema.index({ weekId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('QuizWinner', quizWinnerSchema);
