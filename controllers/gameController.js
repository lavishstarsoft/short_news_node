'use strict';

/**
 * Casual in-app game scores (2048). Signed-in users' best score is saved server-side
 * so it survives a reinstall and feeds the public leaderboard. Score submission is
 * authenticated (verified Google id); the leaderboard is public (drives engagement).
 */

const GameScore = require('../models/GameScore');

const GAMES = ['2048', 'sudoku', 'blocks'];
const gameOf = (req) => (GAMES.includes(String(req.params.game)) ? String(req.params.game) : null);
const uid = (req) => req.verifiedGoogleId || null;
const clampScore = (v) => Math.max(0, Math.min(10000000, parseInt(v, 10) || 0));
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

// POST /api/public/game/:game/score  { score, name, email, photo }
exports.submitScore = async (req, res) => {
  try {
    const GAME = gameOf(req);
    if (!GAME) return res.status(400).json({ error: 'Unknown game.' });
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Sign in to save your score.' });
    const score = clampScore(req.body && req.body.score);
    const name = clip(req.body && req.body.name, 60);
    const email = clip(req.body && req.body.email, 120);
    const photo = clip(req.body && req.body.photo, 400);

    const existing = await GameScore.findOne({ game: GAME, userId });
    if (!existing) {
      await GameScore.create({ game: GAME, userId, name, email, photo, bestScore: score });
    } else {
      if (score > existing.bestScore) existing.bestScore = score; // keep the best
      if (name) existing.name = name;   // always refresh display fields
      if (email) existing.email = email;
      if (photo) existing.photo = photo;
      await existing.save();
    }
    const doc = await GameScore.findOne({ game: GAME, userId }).lean();
    const best = doc ? doc.bestScore : score;
    const rank = (await GameScore.countDocuments({ game: GAME, bestScore: { $gt: best } })) + 1;
    res.json({ ok: true, best, rank });
  } catch (e) {
    console.error('game submitScore:', e.message);
    res.status(500).json({ error: 'Failed to save score.' });
  }
};

// GET /api/public/game/:game/my-score  → { ok, best }  — the signed-in user's own best.
// Read-only. Lets the app show the server best on a fresh install / new phone
// (it used to show 0 because scores were only ever pushed, never pulled).
exports.myScore = async (req, res) => {
  try {
    const GAME = gameOf(req);
    if (!GAME) return res.status(400).json({ error: 'Unknown game.' });
    const userId = uid(req);
    if (!userId) return res.status(401).json({ error: 'Sign in to see your score.' });
    const doc = await GameScore.findOne({ game: GAME, userId }).select('bestScore').lean();
    res.json({ ok: true, best: doc ? doc.bestScore : 0 });
  } catch (e) {
    console.error('game myScore:', e.message);
    res.status(500).json({ error: 'Failed to load score.' });
  }
};

// GET /api/public/game/:game/leaderboard  → top 50 (public, no auth required)
exports.leaderboard = async (req, res) => {
  try {
    const GAME = gameOf(req);
    if (!GAME) return res.status(400).json({ error: 'Unknown game.' });
    const top = await GameScore.find({ game: GAME, bestScore: { $gt: 0 } })
      .sort({ bestScore: -1, updatedAt: 1 })
      .limit(50)
      .select('name photo bestScore')
      .lean();
    res.json({
      leaderboard: top.map((t, i) => ({
        rank: i + 1,
        name: (t.name || 'Player').trim() || 'Player',
        photo: t.photo || '',
        score: t.bestScore,
      })),
    });
  } catch (e) {
    console.error('game leaderboard:', e.message);
    res.status(500).json({ error: 'Failed to load leaderboard.' });
  }
};
