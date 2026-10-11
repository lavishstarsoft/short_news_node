'use strict';

/**
 * Special deck — admin CRUD + public resolver for the LEFT-swipe "special world"
 * on the main news feed. Mirrors reporterAdvertiseController's shape (per-language
 * docs, Redis cache, `.code`-keyed language registry). Additive; never touches
 * the feed endpoints.
 *
 * Public payload: cards are RESOLVED server-side — a `news` card carries the
 * full feed-shaped news object, an `ad` card the feed-shaped ad — so the app
 * renders them with its existing NewsCard / AdCard and never does N extra calls.
 */
const mongoose = require('mongoose');
const SpecialDeck = require('../models/SpecialDeck');
const { redisClient, isRedisAvailable } = require('../config/redis');
const { getActiveLanguages } = require('../services/languageRegistry');
const { displayViews } = require('../services/viewDistribution/displayViews');
const { buildNewsLanguageFilter } = require('../utils/newsLanguages');

const CACHE_TTL = 60;
const cacheKey = (lang) => `special-deck:v1:${lang}`;
const CARD_TYPES = SpecialDeck.CARD_TYPES;
const MAX_CARDS = 30;

// ---------------------------------------------------------------- sanitize
const str = (v, max = 600) => (v == null ? '' : String(v)).trim().slice(0, max);
const num = (v, fb = 1) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const clamp01 = (v) => Math.max(0, Math.min(1, num(v, 0)));
const isObjectId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
const normLang = (v) => str(v, 8).toLowerCase();

const MAX_HOTSPOTS = 12;

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

function normCard(c, i = 0) {
  const s = c && typeof c === 'object' ? c : {};
  const type = CARD_TYPES.includes(String(s.type || '').toLowerCase()) ? String(s.type).toLowerCase() : 'banner';
  const hotspots = type === 'banner' ? normHotspots(s.hotspots) : [];
  return {
    order: num(s.order, i + 1),
    type,
    enabled: s.enabled === undefined ? true : !!s.enabled,
    newsId: type === 'news' && isObjectId(s.newsId) ? String(s.newsId) : '',
    adId: type === 'ad' && isObjectId(s.adId) ? String(s.adId) : '',
    title: str(s.title, 160),
    subtitle: str(s.subtitle, 200),
    imageUrl: str(s.imageUrl, 600),
    linkUrl: str(s.linkUrl, 600),
    hotspots,
    aspectRatio: type === 'banner' && Number(s.aspectRatio) > 0 ? Number(s.aspectRatio) : 0,
  };
}

/** A card the app could actually show (a news/ad card needs its reference). */
function cardIsComplete(c) {
  if (c.type === 'news') return !!c.newsId;
  if (c.type === 'ad') return !!c.adId;
  return true; // quiz / train / banner are self-contained
}

function normCards(list) {
  const src = Array.isArray(list) ? list : [];
  return src
    .slice(0, MAX_CARDS)
    .map((c, i) => normCard(c, i))
    .filter(cardIsComplete)
    .sort((a, b) => a.order - b.order)
    .map((c, i) => ({ ...c, order: i + 1 }));
}

/** Saved doc (may be null) → complete, validated content. */
function mergeDoc(doc, lang) {
  const d = doc || {};
  return { language: lang, enabled: !!d.enabled, cards: normCards(d.cards) };
}

// ---------------------------------------------------------------- app shapes
// Same field set the feed sends (`handleGetNews` in publicRoutes) so the app's
// NewsModel.fromJson / AdModel.fromJson parse it unchanged.
const stripEmails = (list) => (list || []).map(({ userEmail, ...rest }) => rest);

function toAppNews(newsObj) {
  const n = newsObj && newsObj.toObject ? newsObj.toObject() : newsObj;
  const imageUrl = n.thumbnailUrl || n.mediaUrl || n.imageUrl || '/images/placeholder.png';
  const media = n.mediaUrl || n.imageUrl || '/images/placeholder.png';
  return {
    id: String(n._id),
    _id: String(n._id),
    title: n.title || '',
    content: n.content || '',
    imageUrl,
    image_url: imageUrl,
    mediaUrl: media,
    media_url: media,
    mediaType: n.mediaType || 'image',
    media_type: n.mediaType || 'image',
    thumbnailUrl: imageUrl,
    thumbnail_url: imageUrl,
    category: n.category || '',
    location: n.location || '',
    language: n.language || 'te',
    publishedAt: n.publishedAt,
    published_at: n.publishedAt,
    likes: n.likes || 0,
    dislikes: n.dislikes || 0,
    views: displayViews(n),
    comments: n.comments || 0,
    author: n.author || '',
    isRead: false,
    readFullLink: n.readFullLink || null,
    ePaperLink: n.ePaperLink || null,
    userLikes: stripEmails(n.userInteractions && n.userInteractions.likes),
    userDislikes: stripEmails(n.userInteractions && n.userInteractions.dislikes),
    userComments: ((n.userInteractions && n.userInteractions.comments) || []).map((c) => ({
      userId: c.userId, userName: c.userName, comment: c.comment, timestamp: c.timestamp, likes: c.likes || [],
    })),
  };
}

function toAppAd(adObj) {
  const a = adObj && adObj.toObject ? adObj.toObject() : adObj;
  return {
    id: String(a._id),
    title: a.title || '',
    content: a.content,
    imageUrl: a.imageUrl || (a.imageUrls && a.imageUrls.length ? a.imageUrls[0] : '/images/placeholder.png'),
    imageUrls: a.imageUrls || (a.imageUrl ? [a.imageUrl] : []),
    linkUrl: a.linkUrl,
    adFormat: a.adFormat || 'image_only',
    buttonText: a.buttonText,
    positionInterval: a.positionInterval || 3,
    maxViewsPerDay: a.maxViewsPerDay || 3,
    cooldownPeriodHours: a.cooldownPeriodHours || 24,
    frequencyControlEnabled: a.frequencyControlEnabled !== undefined ? a.frequencyControlEnabled : true,
    userBehaviorTrackingEnabled: a.userBehaviorTrackingEnabled !== undefined ? a.userBehaviorTrackingEnabled : true,
    useAdMob: false, // AdMob ads are never placed in the deck (platform-view safety)
    createdAt: a.createdAt,
    language: a.language,
  };
}

/**
 * Turn saved cards into what the app renders. News/ad references that no longer
 * exist (deleted, deactivated, AdMob) are DROPPED so the app never shows a hole.
 * `deps` lets tests inject the models.
 */
async function resolveCards(cards, deps = {}) {
  const News = deps.News || require('../models/News');
  const Ad = deps.Ad || require('../models/Ad');
  const live = (cards || []).filter((c) => c.enabled !== false);
  const newsIds = live.filter((c) => c.type === 'news').map((c) => c.newsId);
  const adIds = live.filter((c) => c.type === 'ad').map((c) => c.adId);

  const [newsDocs, adDocs] = await Promise.all([
    newsIds.length ? News.find({ _id: { $in: newsIds }, isActive: { $ne: false } }).lean() : [],
    adIds.length ? Ad.find({ _id: { $in: adIds }, isActive: true, useAdMob: { $ne: true } }).lean() : [],
  ]);
  const newsById = new Map(newsDocs.map((n) => [String(n._id), n]));
  const adById = new Map(adDocs.map((a) => [String(a._id), a]));

  const out = [];
  for (const c of live) {
    if (c.type === 'news') {
      const n = newsById.get(c.newsId);
      if (n) out.push({ type: 'news', news: toAppNews(n) });
    } else if (c.type === 'ad') {
      const a = adById.get(c.adId);
      if (a) out.push({ type: 'ad', ad: toAppAd(a) });
    } else if (c.type === 'banner') {
      out.push({
        type: 'banner', title: c.title, subtitle: c.subtitle, imageUrl: c.imageUrl, linkUrl: c.linkUrl,
        hotspots: (c.hotspots || []).map((h) => ({ x: h.x, y: h.y, w: h.w, h: h.h, linkUrl: h.linkUrl })),
        aspectRatio: c.aspectRatio || 0,
      });
    } else {
      out.push({ type: c.type, title: c.title, subtitle: c.subtitle, imageUrl: c.imageUrl, linkUrl: c.linkUrl });
    }
  }
  return out;
}

async function bustCache() {
  if (!isRedisAvailable()) return;
  try {
    const langs = getActiveLanguages().map((l) => l.code);
    await Promise.all([...new Set([...langs, 'te', 'en'])].map((l) => redisClient.del(cacheKey(l)).catch(() => {})));
  } catch (_) { /* best-effort */ }
}

// ---------------------------------------------------------------- admin
function renderPage(req, res) {
  try {
    res.render('special-deck', {
      title: 'Special Deck (Left swipe)',
      admin: req.admin,
      activePage: 'special-deck',
      languages: getActiveLanguages(),
    });
  } catch (error) {
    console.error('Error rendering special deck page:', error);
    res.status(500).send('Error loading page');
  }
}

/** Admin list: every active language + its cards, with news/ad labels for display. */
async function getAdmin(req, res) {
  try {
    const News = require('../models/News');
    const Ad = require('../models/Ad');
    const docs = await SpecialDeck.find({}).lean();
    const byLang = {};
    docs.forEach((d) => { byLang[d.language] = d; });
    const items = getActiveLanguages().map((l) => ({ language: l.code, name: l.name || l.code, ...mergeDoc(byLang[l.code] || null, l.code) }));

    // Labels so the admin sees WHICH news / ad each card points to.
    const newsIds = [...new Set(items.flatMap((it) => it.cards.filter((c) => c.newsId).map((c) => c.newsId)))];
    const adIds = [...new Set(items.flatMap((it) => it.cards.filter((c) => c.adId).map((c) => c.adId)))];
    const [newsDocs, adDocs] = await Promise.all([
      newsIds.length ? News.find({ _id: { $in: newsIds } }).select('title thumbnailUrl imageUrl isActive').lean() : [],
      adIds.length ? Ad.find({ _id: { $in: adIds } }).select('title imageUrl imageUrls isActive').lean() : [],
    ]);
    const nl = Object.fromEntries(newsDocs.map((n) => [String(n._id), { label: n.title, image: n.thumbnailUrl || n.imageUrl || '', active: n.isActive !== false }]));
    const al = Object.fromEntries(adDocs.map((a) => [String(a._id), { label: a.title, image: a.imageUrl || (a.imageUrls || [])[0] || '', active: a.isActive === true }]));
    items.forEach((it) => it.cards.forEach((c) => {
      const ref = c.newsId ? nl[c.newsId] : c.adId ? al[c.adId] : null;
      c.refLabel = ref ? ref.label : (c.newsId || c.adId ? '(not found — deleted?)' : '');
      c.refImage = ref ? ref.image : '';
      c.refActive = ref ? ref.active : false;
    }));
    res.json({ success: true, items });
  } catch (error) {
    console.error('Error loading special deck admin:', error);
    res.status(500).json({ error: 'Failed to load' });
  }
}

async function updateAdmin(req, res) {
  try {
    const lang = normLang(req.body.language);
    if (!lang) return res.status(400).json({ error: 'language is required' });
    const merged = mergeDoc(req.body, lang);
    const update = {
      language: lang,
      enabled: merged.enabled,
      cards: merged.cards,
      updatedAt: new Date(),
      updatedBy: (req.admin && (req.admin.username || req.admin.id)) || '',
    };
    const doc = await SpecialDeck.findOneAndUpdate({ language: lang }, { $set: update }, { new: true, upsert: true }).lean();
    await bustCache();
    res.json({ success: true, item: { language: lang, name: lang, ...mergeDoc(doc, lang) } });
  } catch (error) {
    console.error('Error saving special deck:', error);
    res.status(500).json({ error: 'Failed to save' });
  }
}

/** News picker: latest active stories of a language, optional title search. */
async function searchNews(req, res) {
  try {
    const News = require('../models/News');
    const lang = normLang(req.query.lang) || 'te';
    const q = str(req.query.q, 80);
    const query = { isActive: { $ne: false }, ...buildNewsLanguageFilter(lang) };
    if (q) query.title = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const rows = await News.find(query).sort({ publishedAt: -1 }).limit(25).select('title thumbnailUrl imageUrl mediaUrl publishedAt category').lean();
    res.json({ success: true, items: rows.map((n) => ({ id: String(n._id), title: n.title, image: n.thumbnailUrl || n.mediaUrl || n.imageUrl || '', publishedAt: n.publishedAt, category: n.category || '' })) });
  } catch (error) {
    console.error('Error searching news for deck:', error);
    res.status(500).json({ error: 'Search failed' });
  }
}

/** Ad picker: active, non-AdMob ads of a language. */
async function listAds(req, res) {
  try {
    const Ad = require('../models/Ad');
    const lang = normLang(req.query.lang) || 'te';
    const rows = await Ad.find({ language: lang, isActive: true, useAdMob: { $ne: true } }).sort({ createdAt: -1 }).limit(100).select('title imageUrl imageUrls linkUrl').lean();
    res.json({ success: true, items: rows.map((a) => ({ id: String(a._id), title: a.title, image: a.imageUrl || (a.imageUrls || [])[0] || '', linkUrl: a.linkUrl || '' })) });
  } catch (error) {
    console.error('Error listing ads for deck:', error);
    res.status(500).json({ error: 'Load failed' });
  }
}

async function uploadImage(req, res) {
  try {
    if (!req.file || !req.file.path) return res.status(400).json({ error: 'No image uploaded' });
    res.json({ success: true, imageUrl: req.file.path });
  } catch (error) {
    console.error('Error uploading deck image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
}

// ---------------------------------------------------------------- public
const EMPTY = (lang) => ({ success: true, lang, enabled: false, cards: [] });

async function getPublic(req, res) {
  const lang = normLang(req.query.lang) || 'te';
  try {
    if (isRedisAvailable()) {
      const hit = await redisClient.get(cacheKey(lang)).catch(() => null);
      if (hit) { res.set('X-Cache', 'HIT'); return res.json(JSON.parse(hit)); }
    }
    // No DB → deck simply off (the app keeps its normal feed).
    if (mongoose.connection.readyState !== 1) return res.json(EMPTY(lang));

    const doc = await SpecialDeck.findOne({ language: lang }).lean();
    const content = mergeDoc(doc, lang);
    const cards = content.enabled ? await resolveCards(content.cards) : [];
    const payload = { success: true, lang, enabled: content.enabled && cards.length > 0, cards };
    if (isRedisAvailable()) redisClient.setEx(cacheKey(lang), CACHE_TTL, JSON.stringify(payload)).catch(() => {});
    res.set('X-Cache', 'MISS');
    res.json(payload);
  } catch (error) {
    console.error('Error serving public special deck:', error);
    res.json(EMPTY(lang)); // never break the app: deck off
  }
}

module.exports = {
  renderPage, getAdmin, updateAdmin, searchNews, listAds, uploadImage, getPublic,
  // exported for tests
  mergeDoc, normCard, resolveCards, toAppNews, toAppAd, CARD_TYPES,
};
