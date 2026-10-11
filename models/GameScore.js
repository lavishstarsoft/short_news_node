'use strict';

const mongoose = require('mongoose');

/**
 * Per-user best score for an in-app casual game (currently only '2048').
 * Keyed by the verified Google id (same identity as the quiz). Local-only players
 * (no sign-in) keep their score on-device; this collection is for signed-in users
 * so their score survives a reinstall and appears on the public leaderboard.
 */
const gameScoreSchema = new mongoose.Schema(
  {
    game: { type: String, default: '2048' },
    userId: { type: String, required: true }, // verified Google id
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    photo: { type: String, default: '' },
    bestScore: { type: Number, default: 0 },
  },
  { timestamps: true }
);

gameScoreSchema.index({ game: 1, userId: 1 }, { unique: true });
gameScoreSchema.index({ game: 1, bestScore: -1 });

module.exports = mongoose.model('GameScore', gameScoreSchema);
