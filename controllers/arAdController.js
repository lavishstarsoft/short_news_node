'use strict';

const ArAd = require('../models/ArAd');

// Small in-memory cache for the public endpoint so the app's polling never
// hammers Mongo. Admin writes clear it so changes show up immediately.
let _pubCache = null;
let _pubCacheAt = 0;
const PUB_CACHE_MS = 60 * 1000;
function clearPubCache() { _pubCache = null; _pubCacheAt = 0; }

const VALID_CTA = new Set(['url', 'call', 'whatsapp', 'none']);

function sanitize(body) {
  const ctaType = VALID_CTA.has(body.ctaType) ? body.ctaType : 'url';

  let displayNewsIds = (Array.isArray(body.displayNewsIds) ? body.displayNewsIds : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  displayNewsIds = [...new Set(displayNewsIds)].slice(0, 100);

  let bill = parseFloat(body.billAmount);
  if (!Number.isFinite(bill) || bill < 0) bill = 0;

  return {
    title: String(body.title || '').trim(),
    sponsorName: String(body.sponsorName || '').trim(),
    glbUrl: String(body.glbUrl || '').trim(),
    posterImageUrl: String(body.posterImageUrl || '').trim(),
    caption: String(body.caption || '').trim(),
    ctaLabel: String(body.ctaLabel || 'Shop now').trim() || 'Shop now',
    ctaType,
    ctaValue: ctaType === 'none' ? '' : String(body.ctaValue || '').trim(),
    priceInfo: String(body.priceInfo || '').trim(),
    displayNewsIds,
    language: String(body.language || '').trim().toLowerCase(),
    isActive: body.isActive === true || body.isActive === 'true',
    billAmount: bill,
    billNote: String(body.billNote || '').trim(),
  };
}

// ── Admin page ───────────────────────────────────────────────────────────────
async function renderPage(req, res) {
  res.render('ar-ads', { admin: req.admin });
}

// ── Admin CRUD ───────────────────────────────────────────────────────────────
async function list(req, res) {
  try {
    const ads = await ArAd.find({}).sort({ updatedAt: -1 }).lean();
    res.json({ ok: true, ads });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to load AR ads' });
  }
}

async function create(req, res) {
  try {
    const data = sanitize(req.body);
    if (!data.title || !data.glbUrl) {
      return res.status(400).json({ ok: false, error: 'Title and a 3D model (.glb URL) are required' });
    }
    data.author = req.admin?.username || '';
    data.authorId = req.admin?.id || '';
    const ad = await ArAd.create(data);
    clearPubCache();
    res.status(201).json({ ok: true, ad });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'Could not create AR ad: ' + e.message });
  }
}

async function update(req, res) {
  try {
    const data = sanitize(req.body);
    if (!data.title || !data.glbUrl) {
      return res.status(400).json({ ok: false, error: 'Title and a 3D model (.glb URL) are required' });
    }
    const ad = await ArAd.findByIdAndUpdate(req.params.id, data, { new: true });
    if (!ad) return res.status(404).json({ ok: false, error: 'Not found' });
    clearPubCache();
    res.json({ ok: true, ad });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'Could not update AR ad' });
  }
}

async function remove(req, res) {
  try {
    const ad = await ArAd.findByIdAndDelete(req.params.id);
    if (!ad) return res.status(404).json({ ok: false, error: 'Not found' });
    clearPubCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'Could not delete AR ad' });
  }
}

async function toggle(req, res) {
  try {
    const ad = await ArAd.findById(req.params.id);
    if (!ad) return res.status(404).json({ ok: false, error: 'Not found' });
    ad.isActive = !ad.isActive;
    await ad.save();
    clearPubCache();
    res.json({ ok: true, isActive: ad.isActive });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'Could not toggle' });
  }
}

// ── Public (app fetches this) ────────────────────────────────────────────────
// Returns ACTIVE ads for the requested language. Billing/stats are NOT sent.
async function getPublic(req, res) {
  try {
    const lang = String(req.query.lang || '').trim().toLowerCase();
    const now = Date.now();
    if (_pubCache && now - _pubCacheAt < PUB_CACHE_MS) {
      return res.json(filterByLang(_pubCache, lang));
    }
    const rows = await ArAd.find({ isActive: true })
      .select('sponsorName glbUrl posterImageUrl caption ctaLabel ctaType ctaValue priceInfo displayNewsIds language')
      .sort({ updatedAt: -1 })
      .lean();
    _pubCache = rows.map((r) => ({
      id: String(r._id),
      sponsorName: r.sponsorName || '',
      glbUrl: r.glbUrl,
      posterImageUrl: r.posterImageUrl || '',
      caption: r.caption || '',
      ctaLabel: r.ctaLabel || 'Shop now',
      ctaType: r.ctaType || 'url',
      ctaValue: r.ctaValue || '',
      priceInfo: r.priceInfo || '',
      displayNewsIds: Array.isArray(r.displayNewsIds) ? r.displayNewsIds : [],
      language: r.language || '',
    }));
    _pubCacheAt = now;
    res.json(filterByLang(_pubCache, lang));
  } catch (e) {
    res.json({ ok: true, ads: [] }); // never break the app's feed
  }
}

function filterByLang(all, lang) {
  const ads = !lang ? all : all.filter((a) => !a.language || a.language === lang);
  return { ok: true, ads };
}

// ── Tracking (app → counters). No auth: it only increments a counter. ─────────
const VALID_EVENTS = { impression: 'stats.impressions', arOpen: 'stats.arOpens', ctaTap: 'stats.ctaTaps' };
async function track(req, res) {
  try {
    const id = String(req.body.id || '').trim();
    const field = VALID_EVENTS[String(req.body.event || '').trim()];
    if (!id || !field) return res.status(400).json({ ok: false });
    await ArAd.updateOne({ _id: id }, { $inc: { [field]: 1 } });
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false }); // tracking must never surface an error to the app
  }
}

// ── News → AR poster (.glb). Any news image becomes a near-flat textured plate
//    the app opens in Scene Viewer ("news in your room"). Public + cached by
//    image URL so the first tap builds it (~2-4s) and later taps are instant. ──
const _posterCache = new Map(); // imageUrl -> glbUrl
async function newsPoster(req, res) {
  try {
    const img = String(req.query.img || '').trim();
    if (!/^https?:\/\//i.test(img)) {
      return res.status(400).json({ ok: false, error: 'A valid img URL is required' });
    }
    if (_posterCache.has(img)) {
      return res.json({ ok: true, glbUrl: _posterCache.get(img), cached: true });
    }
    const axios = require('axios');
    const crypto = require('crypto');
    const { imageBufferToFlatPosterGlb } = require('../services/embossTo3D');
    const { uploadToR2 } = require('../middleware/upload');

    const resp = await axios.get(img, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 25 * 1024 * 1024 });
    // Clean flat poster: true aspect, bottom-anchored, JPEG texture (small + fast).
    const glb = await imageBufferToFlatPosterGlb(Buffer.from(resp.data), { texSize: 1024, quality: 82 });
    const hash = crypto.createHash('md5').update(img).digest('hex').slice(0, 16);
    const glbUrl = await uploadToR2(Buffer.from(glb), 'ar_posters', `poster_${hash}.glb`, 'model/gltf-binary');
    _posterCache.set(img, glbUrl);
    res.json({ ok: true, glbUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not build AR poster: ' + (e.message || 'failed') });
  }
}

// ── News → AR poster from an UPLOADED card image (public). The app captures the
//    whole news card on-device (so every language renders right) and posts the
//    PNG here; we turn it into a near-flat poster .glb for Scene Viewer. ──
async function newsPosterUpload(req, res) {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ ok: false, error: 'image file required' });
    }
    const { uploadToR2 } = require('../middleware/upload');
    const stamp = Date.now();
    // Always publish the raw card image — the WebXR poster viewer floats this
    // image in the room (gallery-style 1-finger move / 2-finger zoom).
    const ext = /png/i.test(req.file.mimetype || '') ? 'png' : 'jpg';
    const imageUrl = await uploadToR2(req.file.buffer, 'ar_cards', `card_${stamp}.${ext}`, req.file.mimetype || 'image/png');

    // The Scene Viewer .glb is optional now (?glb=0 skips it) — kept for callers
    // that still want a surface-placed poster.
    let glbUrl = '';
    if (String(req.query.glb || '') !== '0') {
      const { imageBufferToFlatPosterGlb } = require('../services/embossTo3D');
      const glb = await imageBufferToFlatPosterGlb(req.file.buffer, { texSize: 1024, quality: 82 });
      glbUrl = await uploadToR2(Buffer.from(glb), 'ar_posters', `card_${stamp}.glb`, 'model/gltf-binary');
    }
    res.json({ ok: true, imageUrl, glbUrl });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not build AR poster: ' + (e.message || 'failed') });
  }
}

// ── News-in-AR enable/disable (which news cards show the 👓 AR button) ─────────
const ArNewsConfig = require('../models/ArNewsConfig');
let _arCfgCache = null, _arCfgAt = 0;

async function newsArPage(req, res) { res.render('news-ar', { admin: req.admin }); }

async function newsArGet(req, res) {
  try {
    const c = await ArNewsConfig.findOne({ key: 'config' }).lean();
    res.json({ ok: true, showOnAll: !!(c && c.showOnAll), enabledNewsIds: (c && c.enabledNewsIds) || [] });
  } catch (e) { res.status(500).json({ ok: false, error: 'load failed' }); }
}

async function newsArSave(req, res) {
  try {
    const showOnAll = req.body.showOnAll === true || req.body.showOnAll === 'true';
    let ids = (Array.isArray(req.body.enabledNewsIds) ? req.body.enabledNewsIds : [])
      .map((s) => String(s || '').trim()).filter(Boolean);
    ids = [...new Set(ids)].slice(0, 500);
    await ArNewsConfig.findOneAndUpdate(
      { key: 'config' },
      { $set: { showOnAll, enabledNewsIds: ids } },
      { upsert: true, new: true }
    );
    _arCfgCache = null; // bust public cache
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: 'save failed' }); }
}

// Public (app): the current News-in-AR config, cached 60s.
async function newsArPublic(req, res) {
  try {
    const now = Date.now();
    if (!_arCfgCache || now - _arCfgAt > 60000) {
      const c = await ArNewsConfig.findOne({ key: 'config' }).lean();
      _arCfgCache = { ok: true, showOnAll: !!(c && c.showOnAll), newsIds: (c && c.enabledNewsIds) || [] };
      _arCfgAt = now;
    }
    res.json(_arCfgCache);
  } catch (e) { res.json({ ok: true, showOnAll: false, newsIds: [] }); }
}

module.exports = {
  renderPage, list, create, update, remove, toggle, getPublic, track, newsPoster, newsPosterUpload,
  newsArPage, newsArGet, newsArSave, newsArPublic,
  _test: { sanitize, clearPubCache },
};
