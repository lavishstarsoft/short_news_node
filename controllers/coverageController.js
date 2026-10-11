'use strict';
const CoverageMap = require('../models/CoverageMap');
const Language = require('../models/Language');

let _cache = null, _at = 0;
const TTL = 60 * 1000;
function invalidate(req) {
  _cache = null; _at = 0;
  try { req.app.locals.io?.emit('coverage_changed', { at: Date.now() }); } catch (_) {}
}

async function getDoc() {
  let d = await CoverageMap.findOne();
  if (!d) d = await CoverageMap.create({ images: [] });
  return d;
}

async function renderPage(req, res) {
  let languages = [];
  try { languages = await Language.getActiveLanguages(); } catch (_) {}
  const d = await getDoc();
  const map = {};
  (d.images || []).forEach((i) => { if (i.language) map[i.language] = i.imageUrl || ''; });
  res.render('coverage', { admin: req.admin, languages, images: map, isActive: d.isActive !== false });
}

async function save(req, res) {
  try {
    const images = (Array.isArray(req.body.images) ? req.body.images : [])
      .filter((i) => i && i.language && i.imageUrl)
      .map((i) => ({ language: String(i.language).toLowerCase().trim(), imageUrl: String(i.imageUrl).trim() }));
    const isActive = req.body.isActive !== false && req.body.isActive !== 'false';
    const d = await getDoc();
    d.images = images;
    d.isActive = isActive;
    d.updatedAt = new Date();
    await d.save();
    invalidate(req);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
}

// Public — the app polls this per language (60s cache, cleared + socket on save).
async function getPublic(req, res) {
  try {
    const now = Date.now();
    if (!_cache || now - _at > TTL) {
      const d = await getDoc();
      _cache = { active: d.isActive !== false, images: d.images || [] };
      _at = now;
    }
    res.set('Cache-Control', 'no-store');
    if (!_cache.active) return res.json({ ok: true, active: false, imageUrl: '' });
    const lang = String((req.query && req.query.lang) || '').toLowerCase();
    const imgs = _cache.images;
    const pick = (c) => (imgs.find((i) => i.language === c) || {}).imageUrl || '';
    const imageUrl = pick(lang) || pick('en') || (imgs.find((i) => i.imageUrl) || {}).imageUrl || '';
    res.json({ ok: true, active: true, imageUrl });
  } catch (e) {
    res.status(500).json({ ok: false, active: false, imageUrl: '' });
  }
}

module.exports = { renderPage, save, getPublic };
