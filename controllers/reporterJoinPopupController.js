'use strict';
const ReporterJoinPopup = require('../models/ReporterJoinPopup');

const KEY = 'default';
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function sanitizeHotspots(raw) {
  if (!Array.isArray(raw)) return [];
  const actions = ['login', 'register', 'url', 'close'];
  return raw.slice(0, 20).map(h => {
    const action = actions.includes(h.action) ? h.action : 'login';
    return {
      x: clamp01(h.x), y: clamp01(h.y), w: clamp01(h.w), h: clamp01(h.h),
      action,
      url: action === 'url' ? String(h.url || '').trim().slice(0, 500) : '',
      label: String(h.label || '').trim().slice(0, 60),
    };
  }).filter(h => h.w > 0.01 && h.h > 0.01);
}

// Admin: editor page
exports.renderPage = async (req, res) => {
  try {
    res.render('reporter-join-popup', {
      title: 'Reporter Join Popup',
      admin: req.admin,
      activePage: 'reporter-join-popup',
    });
  } catch (e) {
    console.error('renderPage join-popup:', e);
    res.status(500).send('Error loading page');
  }
};

// Admin: read current config
exports.getConfig = async (req, res) => {
  try {
    const doc = await ReporterJoinPopup.findOne({ key: KEY }).lean();
    res.json({ ok: true, config: doc || { key: KEY, imageUrl: '', aspectRatio: 0.75, hotspots: [], isActive: false } });
  } catch (e) {
    console.error('getConfig join-popup:', e);
    res.status(500).json({ error: 'Failed to load config' });
  }
};

// Admin: save config (upsert singleton)
exports.saveConfig = async (req, res) => {
  try {
    const imageUrl = String(req.body.imageUrl || '').trim();
    const aspectRatio = Number(req.body.aspectRatio) > 0 ? Number(req.body.aspectRatio) : 0.75;
    const hotspots = sanitizeHotspots(req.body.hotspots);
    const isActive = req.body.isActive === true || req.body.isActive === 'true';
    if (isActive && !imageUrl) return res.status(400).json({ error: 'Upload an image before activating.' });

    const doc = await ReporterJoinPopup.findOneAndUpdate(
      { key: KEY },
      { $set: { imageUrl, aspectRatio, hotspots, isActive, updatedByName: (req.admin && (req.admin.username || req.admin.name)) || '' } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    res.json({ ok: true, config: doc });
  } catch (e) {
    console.error('saveConfig join-popup:', e);
    res.status(500).json({ error: 'Failed to save config' });
  }
};

// Admin: image upload (uploadAdMedia already put it on R2 → req.file.path)
exports.uploadImage = async (req, res) => {
  try {
    if (!req.file || !req.file.path) return res.status(400).json({ error: 'No image uploaded' });
    res.json({ success: true, imageUrl: req.file.path });
  } catch (e) {
    console.error('uploadImage join-popup:', e);
    res.status(500).json({ error: 'Failed to upload image' });
  }
};

// Public: active config for the app (guests see this before login)
exports.getPublic = async (req, res) => {
  try {
    const doc = await ReporterJoinPopup.findOne({ key: KEY, isActive: true }).lean();
    if (!doc || !doc.imageUrl) return res.json({ active: false });
    res.json({
      active: true,
      imageUrl: doc.imageUrl,
      aspectRatio: doc.aspectRatio || 0.75,
      hotspots: (doc.hotspots || []).map(h => ({ x: h.x, y: h.y, w: h.w, h: h.h, action: h.action, url: h.url || '' })),
    });
  } catch (e) {
    console.error('getPublic join-popup:', e);
    res.status(500).json({ active: false });
  }
};
