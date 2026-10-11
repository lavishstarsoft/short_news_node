'use strict';

/**
 * Train Promo Banner — admin CRUD + public resolver for the single banner under
 * "Search history" on the app's train page. Mirrors specialDeckController's
 * banner-hotspot shape (normalised 0..1 coords, Redis cache, R2 image upload).
 * Additive; `enabled` default OFF. Never touches other endpoints.
 */
const mongoose = require('mongoose');
const TrainPromoBanner = require('../models/TrainPromoBanner');
const { redisClient, isRedisAvailable } = require('../config/redis');

const CACHE_TTL = 60;
const CACHE_KEY = 'train-promo-banner:v1';
const MAX_HOTSPOTS = 12;
const KEY = 'default';

// ---------------------------------------------------------------- sanitize
const str = (v, max = 600) => (v == null ? '' : String(v)).trim().slice(0, max);
const num = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const clamp01 = (v) => Math.max(0, Math.min(1, num(v, 0)));

/** A drawn region needs a real size and a link to be worth keeping. */
function normHotspots(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((h) => {
      const s = h && typeof h === 'object' ? h : {};
      let x = clamp01(s.x), y = clamp01(s.y), w = clamp01(s.w), hh = clamp01(s.h);
      if (x + w > 1) w = 1 - x;
      if (y + hh > 1) hh = 1 - y;
      return { x, y, w, h: hh, linkUrl: str(s.linkUrl, 600), label: str(s.label, 120) };
    })
    .filter((h) => h.w >= 0.02 && h.h >= 0.02 && h.linkUrl)
    .slice(0, MAX_HOTSPOTS);
}

/** Saved doc (may be null) → complete, validated content. */
function mergeDoc(doc) {
  const d = doc || {};
  return {
    enabled: !!d.enabled,
    imageUrl: str(d.imageUrl, 600),
    aspectRatio: Number(d.aspectRatio) > 0 ? Number(d.aspectRatio) : 0,
    title: str(d.title, 160),
    subtitle: str(d.subtitle, 200),
    linkUrl: str(d.linkUrl, 600),
    hotspots: normHotspots(d.hotspots),
  };
}

/** Public payload the app renders. OFF or no image → { enabled:false }. */
const EMPTY = { success: true, enabled: false };
function toPublic(content) {
  if (!content.enabled || !content.imageUrl) return EMPTY;
  return {
    success: true,
    enabled: true,
    imageUrl: content.imageUrl,
    aspectRatio: content.aspectRatio || 0,
    title: content.title,
    subtitle: content.subtitle,
    linkUrl: content.linkUrl,
    hotspots: content.hotspots.map((h) => ({ x: h.x, y: h.y, w: h.w, h: h.h, linkUrl: h.linkUrl })), // label stripped
  };
}

async function bustCache() {
  if (!isRedisAvailable()) return;
  try { await redisClient.del(CACHE_KEY).catch(() => {}); } catch (_) { /* best-effort */ }
}

// ---------------------------------------------------------------- admin
function renderPage(req, res) {
  try {
    res.render('train-promo-banner', {
      title: 'Train Promo Banner',
      admin: req.admin,
      activePage: 'train-promo-banner',
    });
  } catch (error) {
    console.error('Error rendering train promo banner page:', error);
    res.status(500).send('Error loading page');
  }
}

async function getAdmin(req, res) {
  try {
    const doc = await TrainPromoBanner.findOne({ key: KEY }).lean();
    res.json({ success: true, item: mergeDoc(doc) });
  } catch (error) {
    console.error('Error loading train promo banner admin:', error);
    res.status(500).json({ error: 'Failed to load' });
  }
}

async function updateAdmin(req, res) {
  try {
    const merged = mergeDoc(req.body);
    const update = {
      key: KEY,
      ...merged,
      updatedAt: new Date(),
      updatedBy: (req.admin && (req.admin.username || req.admin.id)) || '',
    };
    const doc = await TrainPromoBanner.findOneAndUpdate({ key: KEY }, { $set: update }, { new: true, upsert: true }).lean();
    await bustCache();
    res.json({ success: true, item: mergeDoc(doc) });
  } catch (error) {
    console.error('Error saving train promo banner:', error);
    res.status(500).json({ error: 'Failed to save' });
  }
}

async function uploadImage(req, res) {
  try {
    if (!req.file || !req.file.path) return res.status(400).json({ error: 'No image uploaded' });
    res.json({ success: true, imageUrl: req.file.path });
  } catch (error) {
    console.error('Error uploading train promo image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
}

// ---------------------------------------------------------------- public
async function getPublic(req, res) {
  try {
    if (isRedisAvailable()) {
      const hit = await redisClient.get(CACHE_KEY).catch(() => null);
      if (hit) { res.set('X-Cache', 'HIT'); return res.json(JSON.parse(hit)); }
    }
    // No DB → banner simply off (the app keeps its static card).
    if (mongoose.connection.readyState !== 1) return res.json(EMPTY);

    const doc = await TrainPromoBanner.findOne({ key: KEY }).lean();
    const payload = toPublic(mergeDoc(doc));
    if (isRedisAvailable()) redisClient.setEx(CACHE_KEY, CACHE_TTL, JSON.stringify(payload)).catch(() => {});
    res.set('X-Cache', 'MISS');
    res.json(payload);
  } catch (error) {
    console.error('Error serving public train promo banner:', error);
    res.json(EMPTY); // never break the app: banner off
  }
}

module.exports = {
  renderPage, getAdmin, updateAdmin, uploadImage, getPublic,
  // exported for tests
  mergeDoc, normHotspots, toPublic,
};
