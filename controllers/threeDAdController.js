'use strict';

const ThreeDAd = require('../models/ThreeDAd');
const News = require('../models/News');
const { getDisplayConfigForLanguage } = require('../services/newsDisplayConfig');

// ── Safe-device analysis (mirrors the admin "Device Coverage" analyze()) ─────
const _CH_PAD = 9, _IMG_TITLE_GAP = 8, _TC_SPACING = 4, _AD_H = 128, _AD_BOTTOM = 96;
const _DEV_CATS = [
  { key: 'small', w: 320, h: 480 }, { key: 'compact', w: 360, h: 640 },
  { key: 'standard', w: 360, h: 740 }, { key: 'large', w: 393, h: 851 },
  { key: 'xlarge', w: 428, h: 926 }, { key: 'tablet', w: 768, h: 1024 },
];
function _phoneMetrics(w, h) {
  let frac, ts = 1, cs = 1, bp = 92;
  if (h < 360) { frac = .24; ts = .89; cs = .89; bp = 68; }
  else if (h < 520) { frac = .28; ts = .94; cs = .94; bp = 76; }
  else if (h < 640) { frac = .32; bp = 84; }
  else if (h < 760) { frac = .36; bp = 88; }
  else { frac = .40; bp = 92; }
  let mh = Math.min(Math.max(h * frac, 72), h * 0.45);
  mh = Math.min(mh, w / 1.15);
  return { mediaHeight: mh, bottomPad: bp, titleScale: ts, contentScale: cs };
}
// 'ok' | 'warn' | 'bad' for the bottom-right cube over a worst-case news on [dev].
function _adVerdict(dev, titleLen, contentLen, cfg) {
  const w = dev.w, h = dev.h;
  if (Math.min(w, h) >= 600) return 'ok'; // tablet — roomy, no clip/overlap
  const m = _phoneMetrics(w, h);
  const titleSize = cfg.titleFontSize * m.titleScale;
  const contentSize = cfg.contentFontSize * m.contentScale;
  const cw = w - 2 * _CH_PAD;
  const tCPL = Math.max(8, Math.floor(cw / (titleSize * 0.55)));
  const cCPL = Math.max(8, Math.floor(cw / (contentSize * 0.52)));
  const tLines = Math.max(1, Math.ceil(titleLen / tCPL));
  const cLines = Math.max(1, Math.ceil(contentLen / cCPL));
  const titleH = tLines * titleSize * cfg.titleLineHeight;
  const contentH = cLines * contentSize * cfg.contentLineHeight;
  const textTop = m.mediaHeight + _IMG_TITLE_GAP;
  const availH = h - textTop - _TC_SPACING - m.bottomPad;
  const neededH = titleH + _TC_SPACING + contentH;
  const shrink = neededH > availH ? Math.max(availH / neededH, 0.6) : 1;
  const descTop = textTop + titleH * shrink + _TC_SPACING;
  const descBottom = Math.min(descTop + contentH * shrink, h - m.bottomPad);
  const adTopY = h - _AD_BOTTOM - _AD_H, adBottomY = h - _AD_BOTTOM;
  const ovH = Math.max(0, Math.min(adBottomY, descBottom) - Math.max(adTopY, descTop));
  const lineH = contentSize * cfg.contentLineHeight * shrink;
  const ovLines = lineH > 0 ? ovH / lineH : 0;
  if (shrink < 0.8) return 'bad';
  if (ovLines >= 3) return 'bad';
  if (ovLines >= 0.5) return 'warn';
  return 'ok';
}
// Device keys where the ad is SAFE (verdict 'ok') for a worst-case news in [cfg].
function computeSafeDeviceSizes(cfg) {
  const titleLen = cfg.titleMax || 60;
  const contentLen = cfg.contentMax || 380;
  // Skip only devices where the cube CLEARLY covers the text ('bad'); keep
  // 'ok' and the borderline 'warn' so the ad still reaches enough devices.
  const safe = _DEV_CATS.filter((d) => _adVerdict(d, titleLen, contentLen, cfg) !== 'bad').map((d) => d.key);
  if (safe.length >= _DEV_CATS.length) return [];          // all safe => all devices
  return safe.length ? safe : ['large', 'xlarge', 'tablet']; // never serve an empty set
}

// Auto-safe, measured against the WHOLE live feed (every news, actual text —
// not one assumed worst-case length). For each device category we count how
// many real news the cube would bury ('bad'); a device is kept only if almost
// none are buried. Result = the device sizes on which the ad is safe for every
// news, so it can ride on ALL news cards there without ever covering the text.
const _AUTO_SAFE_BAD_TOLERANCE = 0.02; // allow ≤2% odd-outlier news per device
function computeAutoSafeDevicesFromFeed(newsDocs, cfgByLang) {
  const total = newsDocs.length;
  if (!total) return ['large', 'xlarge', 'tablet']; // safe default, never empty
  const safe = _DEV_CATS.filter((d) => {
    let bad = 0;
    for (const n of newsDocs) {
      const cfg = cfgByLang[(n.language || '').toLowerCase()] || cfgByLang._default;
      if (!cfg) continue;
      if (_adVerdict(d, (n.title || '').length, (n.content || '').length, cfg) === 'bad') bad++;
    }
    return bad / total <= _AUTO_SAFE_BAD_TOLERANCE;
  }).map((d) => d.key);
  if (safe.length >= _DEV_CATS.length) return [];            // all safe => all devices
  return safe.length ? safe : ['large', 'xlarge', 'tablet']; // never serve an empty set
}

// Tiny in-memory cache for the public endpoint so the app's polling never
// hammers Mongo. Admin writes clear it so changes show up immediately.
let _pubCache = null;
let _pubCacheAt = 0;
const PUB_CACHE_MS = 60 * 1000;
function clearPubCache() { _pubCache = null; _pubCacheAt = 0; }

// Clear the cache AND tell every connected app to refetch ads NOW (instead of
// waiting out its own cache). Event-driven: only fires on an admin write, so no
// polling / extra DB load. Safe no-op if sockets aren't available.
function invalidateAndPush(req) {
  clearPubCache();
  try { req.app.locals.io?.emit('three_d_ads_changed', { at: Date.now() }); } catch (_) {}
}

const VALID_TARGETS = new Set(['quiz', 'train', 'games', 'viral', 'url', 'news']);
const VALID_STYLES = new Set(['spin', 'flip', 'coin', 'cube', 'mascot', 'static']);
const DEFAULT_LOGO = '/images/logo.png';

function sanitize(body) {
  const targetType = VALID_TARGETS.has(body.targetType) ? body.targetType : 'quiz';
  const rotateStyle = VALID_STYLES.has(body.rotateStyle) ? body.rotateStyle : 'spin';
  let speed = parseInt(body.speedSeconds, 10);
  if (!Number.isFinite(speed)) speed = 6;
  speed = Math.min(30, Math.max(2, speed));

  // Cube/dice: up to 4 side images. Trimmed, non-empty, capped at 4.
  const cubeImages = (Array.isArray(body.cubeImages) ? body.cubeImages : [])
    .map((u) => String(u || '').trim())
    .filter(Boolean)
    .slice(0, 4);

  // imageUrl drives the list thumbnail + the single-image styles. For a cube ad
  // it may be empty (the user filled only the side slots), so fall back to the
  // first side, then the logo — never blank.
  let imageUrl = String(body.imageUrl || '').trim();
  if (!imageUrl && rotateStyle === 'cube') imageUrl = cubeImages[0] || DEFAULT_LOGO;

  // Floating mascot: the animation lives in mascotUrl (Lottie .json or image).
  // Mirror it into imageUrl (the required field / list thumbnail) when needed.
  const mascotUrl = String(body.mascotUrl || '').trim();
  const bannerText = String(body.bannerText || '').trim().slice(0, 40);
  if (!imageUrl && rotateStyle === 'mascot') imageUrl = mascotUrl || DEFAULT_LOGO;

  // Plain-image extras: media kind + URLs, on-card position, nudge, width.
  const VALID_POS = new Set(['top_left', 'top_center', 'top_right', 'center_left', 'center',
    'center_right', 'bottom_left', 'bottom_center', 'bottom_right', 'below_body']);
  const plainPosition = VALID_POS.has(body.plainPosition) ? body.plainPosition : 'bottom_right';
  const clampNudge = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(300, Math.max(-300, n)) : 0; };
  const plainOffsetX = clampNudge(body.plainOffsetX);
  const plainOffsetY = clampNudge(body.plainOffsetY);
  const VALID_MEDIA = new Set(['image', 'lottie', 'video']);
  const plainMedia = VALID_MEDIA.has(body.plainMedia) ? body.plainMedia : 'image';
  const lottieUrl = String(body.lottieUrl || '').trim();
  const videoUrl = String(body.videoUrl || '').trim();
  let plainWidth = parseInt(body.plainWidth, 10);
  if (!Number.isFinite(plainWidth) || plainWidth < 0) plainWidth = 0;
  plainWidth = Math.min(1200, plainWidth);
  // A Lottie/video plain ad may have no image: keep the required thumbnail filled.
  if (!imageUrl && rotateStyle === 'static') {
    imageUrl = (plainMedia === 'lottie' ? lottieUrl : plainMedia === 'video' ? videoUrl : '') || DEFAULT_LOGO;
  }

  // News cards this ad is pinned to. Accepts an array, plus the legacy single
  // field, deduped and capped.
  let displayNewsIds = (Array.isArray(body.displayNewsIds) ? body.displayNewsIds : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const legacyNewsId = String(body.displayNewsId || '').trim();
  if (legacyNewsId) displayNewsIds.push(legacyNewsId);
  displayNewsIds = [...new Set(displayNewsIds)].slice(0, 100);

  // Device size targeting. Empty = show on all devices (backward compatible).
  const VALID_SIZES = ['small', 'compact', 'standard', 'large', 'xlarge', 'tablet'];
  let deviceSizes = (Array.isArray(body.deviceSizes) ? body.deviceSizes : [])
    .map((s) => String(s || '').trim().toLowerCase())
    .filter((s) => VALID_SIZES.includes(s));
  // If every category is selected, store [] (= all) so it stays future-proof.
  deviceSizes = [...new Set(deviceSizes)];
  if (deviceSizes.length >= VALID_SIZES.length) deviceSizes = [];

  return {
    title: String(body.title || '').trim(),
    imageUrl,
    glbUrl: String(body.glbUrl || '').trim(),
    cubeImages,
    displayNewsIds,
    targetType,
    targetValue: (targetType === 'url' || targetType === 'news') ? String(body.targetValue || '').trim() : '',
    rotateStyle,
    speedSeconds: speed,
    language: String(body.language || '').trim().toLowerCase(),
    languages: (() => {
      let ls = (Array.isArray(body.languages) ? body.languages : [])
        .map((s) => String(s || '').trim().toLowerCase())
        .filter(Boolean);
      return [...new Set(ls)].slice(0, 20); // [] = all languages
    })(),
    deviceSizes,
    allPosts: body.allPosts === true || body.allPosts === 'true',
    autoSafeDevices: body.autoSafeDevices === true || body.autoSafeDevices === 'true',
    mascotUrl,
    bannerText,
    plainPosition,
    plainOffsetX,
    plainOffsetY,
    plainMedia,
    lottieUrl,
    videoUrl,
    plainWidth,
    isActive: body.isActive === true || body.isActive === 'true',
  };
}

// ── Admin page ─────────────────────────────────────────────────────────────
async function renderPage(req, res) {
  res.render('threed-ads', { admin: req.admin });
}

// ── Admin CRUD ──────────────────────────────────────────────────────────────
async function list(req, res) {
  try {
    const ads = await ThreeDAd.find({}).sort({ updatedAt: -1 }).lean();
    res.json({ ok: true, ads });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to load 3D ads' });
  }
}

async function create(req, res) {
  try {
    const data = sanitize(req.body);
    if (!data.title || !data.imageUrl) {
      return res.status(400).json({ ok: false, error: 'Title and image are required' });
    }
    data.author = req.admin?.username || '';
    data.authorId = req.admin?.id || '';
    const ad = await ThreeDAd.create(data);
    invalidateAndPush(req);
    res.status(201).json({ ok: true, ad });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'Could not create 3D ad: ' + e.message });
  }
}

async function update(req, res) {
  try {
    const data = sanitize(req.body);
    if (!data.title || !data.imageUrl) {
      return res.status(400).json({ ok: false, error: 'Title and image are required' });
    }
    const ad = await ThreeDAd.findByIdAndUpdate(req.params.id, data, { new: true });
    if (!ad) return res.status(404).json({ ok: false, error: 'Not found' });
    invalidateAndPush(req);
    res.json({ ok: true, ad });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'Could not update 3D ad' });
  }
}

async function remove(req, res) {
  try {
    const ad = await ThreeDAd.findByIdAndDelete(req.params.id);
    if (!ad) return res.status(404).json({ ok: false, error: 'Not found' });
    invalidateAndPush(req);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'Could not delete 3D ad' });
  }
}

async function toggle(req, res) {
  try {
    const ad = await ThreeDAd.findById(req.params.id);
    if (!ad) return res.status(404).json({ ok: false, error: 'Not found' });
    ad.isActive = !ad.isActive;
    await ad.save();
    invalidateAndPush(req);
    res.json({ ok: true, isActive: ad.isActive });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'Could not toggle' });
  }
}

// ── Public (app fetches this) ────────────────────────────────────────────────
// Returns ACTIVE ads for the requested language (plus all-language ones). An
// empty list means the app simply shows nothing — safe default / feature OFF.
async function getPublic(req, res) {
  try {
    const lang = String(req.query.lang || '').trim().toLowerCase();
    const now = Date.now();
    if (_pubCache && now - _pubCacheAt < PUB_CACHE_MS) {
      return res.json(filterByLang(_pubCache, lang));
    }
    const rows = await ThreeDAd.find({ isActive: true })
      .select('imageUrl glbUrl cubeImages displayNewsIds displayNewsId targetType targetValue rotateStyle speedSeconds language languages deviceSizes allPosts autoSafeDevices mascotUrl bannerText plainPosition plainOffsetX plainOffsetY plainMedia lottieUrl videoUrl plainWidth')
      .sort({ updatedAt: -1 })
      .lean();

    // Fetch recent news ONCE if any ad needs the feed (allPosts) or the per-news
    // auto-safe scan. autoSafe needs the real text (title/content); allPosts only
    // needs ids, so we grab text whenever at least one autoSafe ad exists.
    const needsText = rows.some((r) => r.autoSafeDevices);
    const needsFeed = needsText || rows.some((r) => r.allPosts);
    let allPostIds = [];
    let autoSafeSizes = ['large', 'xlarge', 'tablet']; // safe default until measured
    if (needsFeed) {
      const sel = needsText ? '_id title content language' : '_id';
      const news = await News.find({ isActive: { $ne: false } })
        .select(sel).sort({ publishedAt: -1 }).limit(1500).lean();
      allPostIds = news.map((n) => String(n._id));
      if (needsText) {
        // Load each language's display config once (not per news), default to 'te'.
        const langs = [...new Set(news.map((n) => (n.language || '').toLowerCase()).filter(Boolean))];
        const cfgByLang = {};
        try { cfgByLang._default = await getDisplayConfigForLanguage('te'); } catch (_) { cfgByLang._default = null; }
        for (const lg of langs) {
          try { cfgByLang[lg] = await getDisplayConfigForLanguage(lg); } catch (_) { cfgByLang[lg] = cfgByLang._default; }
        }
        if (cfgByLang._default) autoSafeSizes = computeAutoSafeDevicesFromFeed(news, cfgByLang);
      }
    }

    _pubCache = rows.map((r) => {
      // Which news cards this ad rides on:
      //  • autoSafe / allPosts → every recent news (autoSafe is then limited to
      //    the device sizes safe for the whole feed)
      //  • otherwise → the manually pinned ids
      let ids;
      if (r.autoSafeDevices || r.allPosts) {
        ids = allPostIds.slice();
      } else {
        ids = Array.isArray(r.displayNewsIds) ? r.displayNewsIds.slice() : [];
        if (r.displayNewsId && !ids.includes(r.displayNewsId)) ids.push(r.displayNewsId);
      }
      return {
      id: String(r._id),
      imageUrl: r.imageUrl,
      glbUrl: r.glbUrl || '',
      cubeImages: r.cubeImages || [],
      displayNewsIds: ids,
      targetType: r.targetType,
      targetValue: r.targetValue || '',
      rotateStyle: r.rotateStyle || 'spin',
      speedSeconds: r.speedSeconds || 6,
      language: r.language || '',
      languages: Array.isArray(r.languages) ? r.languages.filter(Boolean) : [],
      // autoSafe → device sizes safe for the whole live feed (every news checked).
      deviceSizes: r.autoSafeDevices ? autoSafeSizes : (Array.isArray(r.deviceSizes) ? r.deviceSizes : []),
      mascotUrl: r.mascotUrl || '',
      bannerText: r.bannerText || '',
      plainPosition: r.plainPosition || 'bottom_right',
      plainOffsetX: r.plainOffsetX || 0,
      plainOffsetY: r.plainOffsetY || 0,
      plainMedia: r.plainMedia || 'image',
      lottieUrl: r.lottieUrl || '',
      videoUrl: r.videoUrl || '',
      plainWidth: r.plainWidth || 0,
      };
    });
    _pubCacheAt = now;
    res.json(filterByLang(_pubCache, lang));
  } catch (e) {
    res.json({ ok: true, ads: [] }); // never break the app's feed
  }
}

// Effective target languages for an ad: the multi `languages` array wins when
// it has entries; otherwise the legacy single `language`; [] means all.
function adLangs(a) {
  const arr = Array.isArray(a.languages) ? a.languages.filter(Boolean) : [];
  if (arr.length) return arr;
  if (a.language) return [a.language];
  return [];
}

function filterByLang(all, lang) {
  const ads = !lang ? all : all.filter((a) => {
    const L = adLangs(a);
    return L.length === 0 || L.includes(lang);
  });
  return { ok: true, ads };
}

// ── Emboss: image → real 3D .glb (free, on-CPU) → uploaded to R2 ──────────────
async function emboss(req, res) {
  try {
    const imageUrl = String(req.body.imageUrl || '').trim();
    if (!/^https?:\/\//i.test(imageUrl)) {
      return res.status(400).json({ ok: false, error: 'A valid imageUrl is required' });
    }
    const axios = require('axios');
    const { imageBufferToGlb } = require('../services/embossTo3D');
    const { uploadToR2 } = require('../middleware/upload');

    const resp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000, maxContentLength: 25 * 1024 * 1024 });
    const glb = await imageBufferToGlb(Buffer.from(resp.data), {
      depth: req.body.depth,
      grid: req.body.grid,
      invert: req.body.invert === true || req.body.invert === 'true',
    });
    const glbUrl = await uploadToR2(Buffer.from(glb), 'threed_ads', `emboss_${Date.now()}.glb`, 'model/gltf-binary');
    res.json({ ok: true, glbUrl, bytes: glb.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not generate 3D model: ' + (e.message || 'failed') });
  }
}

// Upload a Lottie animation (.json) for the floating-mascot style → stores it on
// R2 and returns its public URL. Validates the file is real JSON first. Additive.
async function uploadLottie(req, res) {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, error: 'No file uploaded' });
    }
    // Must be valid JSON (a Lottie animation). Reject anything else.
    let parsed;
    try { parsed = JSON.parse(req.file.buffer.toString('utf8')); } catch (_) {
      return res.status(400).json({ ok: false, error: 'Not a valid .json file' });
    }
    if (!parsed || typeof parsed !== 'object') {
      return res.status(400).json({ ok: false, error: 'Invalid Lottie JSON' });
    }
    const { uploadToR2 } = require('../middleware/upload');
    const url = await uploadToR2(req.file.buffer, 'threed_ads', `mascot_${Date.now()}.json`, 'application/json');
    res.json({ ok: true, url });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Could not upload Lottie: ' + (e.message || 'failed') });
  }
}

module.exports = {
  renderPage, list, create, update, remove, toggle, getPublic, emboss, uploadLottie,
  _test: { sanitize, clearPubCache },
};
