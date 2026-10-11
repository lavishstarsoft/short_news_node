'use strict';
const DicePage = require('../models/DicePage');

let _cache = null, _at = 0;
const TTL = 60 * 1000;
function invalidate(req) {
  _cache = null; _at = 0;
  try { req.app.locals.io?.emit('dice_pages_changed', { at: Date.now() }); } catch (_) {}
}

const VALID = new Set(['news', 'games', 'train', 'quiz', 'viral', 'url', 'meta', 'none']);
function sanitize(b) {
  const faces = (Array.isArray(b.faces) ? b.faces : []).slice(0, 6).map((f) => ({
    imageUrl: String(f.imageUrl || '').trim(),
    targetType: VALID.has(f.targetType) ? f.targetType : 'none',
    targetValue: String(f.targetValue || '').trim(),
    label: String(f.label || '').trim().slice(0, 40),
  }));
  return {
    title: String(b.title || '').trim(),
    faces,
    everyNCards: Math.min(Math.max(parseInt(b.everyNCards, 10) || 8, 2), 100),
    language: String(b.language || '').trim().toLowerCase(),
    isActive: b.isActive === true || b.isActive === 'true',
  };
}

async function renderPage(req, res) { res.render('dice-ads', { admin: req.admin }); }
// Face image upload — uploadAdMedia already put it on R2 untouched (req.file.path).
async function upload(req, res) {
  if (!req.file || !req.file.path) return res.status(400).json({ ok: false, error: 'No image uploaded' });
  res.json({ ok: true, mediaUrl: req.file.path });
}
async function list(req, res) {
  try { res.json({ ok: true, rows: await DicePage.find({}).sort({ updatedAt: -1 }).lean() }); }
  catch (e) { res.status(500).json({ ok: false, error: 'Failed to load' }); }
}
async function create(req, res) {
  try {
    const d = sanitize(req.body);
    if (!d.title || !d.faces.some((f) => f.imageUrl)) return res.status(400).json({ ok: false, error: 'Title + at least one face image required' });
    const row = await DicePage.create(d); invalidate(req);
    res.status(201).json({ ok: true, row });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}
async function update(req, res) {
  try {
    const row = await DicePage.findByIdAndUpdate(req.params.id, sanitize(req.body), { new: true });
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    invalidate(req); res.json({ ok: true, row });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}
async function remove(req, res) {
  try { await DicePage.findByIdAndDelete(req.params.id); invalidate(req); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false }); }
}
async function toggle(req, res) {
  try {
    const row = await DicePage.findById(req.params.id);
    if (!row) return res.status(404).json({ ok: false });
    row.isActive = !row.isActive; await row.save(); invalidate(req);
    res.json({ ok: true, isActive: row.isActive });
  } catch (e) { res.status(400).json({ ok: false }); }
}
// Public — the app polls this (60s cache; admin writes clear it + push socket).
async function getPublic(req, res) {
  try {
    const now = Date.now();
    const lang = String((req.query && req.query.lang) || '').toLowerCase();
    if (!_cache || now - _at > TTL) {
      const rows = await DicePage.find({ isActive: true }).sort({ updatedAt: -1 }).lean();
      _cache = rows.map((r) => ({
        id: String(r._id), title: r.title, faces: r.faces || [],
        everyNCards: r.everyNCards || 8, language: r.language || '',
      }));
      _at = now;
    }
    const out = lang ? _cache.filter((d) => !d.language || d.language === lang) : _cache;
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, dice: out });
  } catch (e) { res.status(500).json({ ok: false, dice: [] }); }
}

module.exports = { renderPage, upload, list, create, update, remove, toggle, getPublic };
