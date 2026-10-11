'use strict';

const mongoose = require('mongoose');

/**
 * Admin-designed Games page: a single uploaded image shown full-screen in the app,
 * with tappable ZONES drawn on top. Each zone maps a rectangle (stored as 0..1
 * fractions of the image, so it fits every device size) to a game key. Tapping a
 * zone opens that game. Same idea as the quiz sign-in image + draggable button box,
 * but with multiple zones (one per game).
 */
const zoneSchema = new mongoose.Schema(
  {
    game: { type: String, default: 'sudoku' }, // sudoku | 2048 | spin | word
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 },
    w: { type: Number, default: 0 },
    h: { type: Number, default: 0 },
  },
  { _id: false }
);

const gamesLayoutSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'games_layout', unique: true },
    imageUrl: { type: String, default: '' },
    enabled: { type: Boolean, default: true }, // false → app uses its built-in grid
    zones: { type: [zoneSchema], default: [] },
    updatedByName: { type: String, default: 'system' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('GamesLayout', gamesLayoutSchema);
