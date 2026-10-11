'use strict';

/**
 * Admin-designed Games page (image + tap zones). Admin uploads one image and drags
 * a box over each game; the app shows the image full-screen and opens the mapped
 * game when a box is tapped. Rects are 0..1 fractions (device-independent).
 */

const GamesLayout = require('../models/GamesLayout');

// SINGLE SOURCE OF TRUTH for the games-layout dropdown: only games that are
// actually LIVE in the app. `key` MUST match the Flutter game key (games_hub
// _openGame / ad app:// route). Add a row here when a new game ships — the admin
// dropdown then updates automatically (no dummy "coming soon" entries).
const GAMES = [
  { key: 'sudoku', name: 'Sudoku' },
  { key: 'blocks', name: 'Block Puzzle' },
];
const GAME_KEYS = GAMES.map((g) => g.key);
const KEY = 'games_layout';
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function sanitizeZones(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((z) => z && GAME_KEYS.includes(String(z.game)))
    .map((z) => ({ game: String(z.game), x: clamp01(z.x), y: clamp01(z.y), w: clamp01(z.w), h: clamp01(z.h) }))
    .filter((z) => z.w > 0 && z.h > 0)
    .slice(0, 12);
}

// ── Admin: render page ──
exports.renderPage = async (req, res) => {
  try {
    res.render('games-layout', { title: 'Games Page', activePage: 'games-layout', admin: req.admin });
  } catch (e) {
    console.error('games-layout render:', e);
    res.status(500).send('Error loading page');
  }
};

// ── Admin: get current layout ──
exports.getLayout = async (req, res) => {
  try {
    const d = await GamesLayout.findOne({ key: KEY }).lean();
    res.json({
      imageUrl: (d && d.imageUrl) || '',
      enabled: d ? d.enabled !== false : true,
      zones: (d && d.zones) || [],
      games: GAMES,
    });
  } catch (e) {
    console.error('games-layout get:', e.message);
    res.status(500).json({ error: 'Failed to load layout.' });
  }
};

// ── Admin: save layout ──
exports.saveLayout = async (req, res) => {
  try {
    const imageUrl = String((req.body && req.body.imageUrl) || '').trim().slice(0, 500);
    const enabled = req.body && req.body.enabled !== false && req.body.enabled !== 'false';
    const zones = sanitizeZones(req.body && req.body.zones);
    await GamesLayout.updateOne(
      { key: KEY },
      { $set: { imageUrl, enabled, zones, updatedByName: req.admin ? (req.admin.name || req.admin.username) : 'admin' } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('games-layout save:', e.message);
    res.status(500).json({ error: 'Failed to save layout.' });
  }
};

// ── Public: layout for the app ──
exports.publicLayout = async (req, res) => {
  try {
    const d = await GamesLayout.findOne({ key: KEY }).lean();
    const enabled = d ? d.enabled !== false : false;
    res.json({
      imageUrl: enabled ? ((d && d.imageUrl) || '') : '',
      zones: enabled ? ((d && d.zones) || []) : [],
    });
  } catch (e) {
    console.error('games-layout public:', e.message);
    res.json({ imageUrl: '', zones: [] });
  }
};
