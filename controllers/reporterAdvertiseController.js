'use strict';

/**
 * Reporter "Advertise / Earn extra income" landing page — admin CRUD + public
 * read. Mirrors reporterHubController's shape (per-language docs, en fallback,
 * built-in defaults so the screen is never empty). Additive; never touches the
 * hub or the main app.
 */
const ReporterAdvertisePage = require('../models/ReporterAdvertisePage');
const { redisClient, isRedisAvailable } = require('../config/redis');
const { getActiveLanguages } = require('../services/languageRegistry');

const CACHE_TTL = 60;
const cacheKey = (lang) => `reporter-advertise:v1:${lang}`;
const BLOCK_TYPES = ['paragraph', 'heading', 'highlight', 'bullets'];
const CTA_ACTIONS = ['whatsapp', 'url', 'none'];
const OVERLAY_SIDES = ['right', 'left', 'bottom'];
const MAX = { blocks: 30, bullets: 20 };

// ---------------------------------------------------------------- defaults
const DEFAULTS = {
  en: {
    banner: { imageUrl: '', title: 'A chance to earn extra income', subtitle: 'Together with Tehelka News', overlaySide: 'right' },
    blocks: [
      { order: 1, type: 'paragraph', text: 'As you move around your area every day and stay close to the people, you build strong local connections and ground information. That can now earn you extra income.' },
      { order: 2, type: 'highlight', text: 'Share news that is useful to the sales team, and you get 10% commission on the advertisement sale that happens from it.' },
      { order: 3, type: 'heading', text: 'News you can share' },
      { order: 4, type: 'paragraph', text: 'Please share the following, as soon as you see it in your area:' },
      { order: 5, type: 'bullets', items: ['New shop openings', 'New restaurant / hotel launches', 'New showrooms / brand stores', 'Hospital / clinic openings'] },
    ],
    cta: { label: 'To earn extra income', action: 'whatsapp', value: '' },
  },
  te: {
    banner: { imageUrl: '', title: 'అదనపు ఆదాయం సంపాదించే అవకాశం', subtitle: 'తెహెల్కా న్యూస్ తో కలిసి', overlaySide: 'right' },
    blocks: [
      { order: 1, type: 'paragraph', text: 'మీరు ప్రతిరోజూ మీ ప్రాంతంలో తిరుగుతూ, ప్రజలతో మమేకమై, స్థానిక పరిణామాలపై మంచి పట్టు కలిగి ఉంటారు. మీ దగ్గర ఉండే ఈ లోకల్ కనెక్షన్స్ మరియు గ్రౌండ్ ఇన్ఫర్మేషన్ ఇప్పుడు మీకు అదనపు ఆదాయం తీసుకురాగలదు.' },
      { order: 2, type: 'highlight', text: 'సేల్స్ టీమ్‌కు ఉపయోగపడే కొన్ని ముఖ్యమైన సమాచారం మీరు పంచితే, ఆ సమాచారంపై జరిగే వ్యాపారం (advertisement sale) పై మీకు 10% కమిషన్ అందించబడుతుంది.' },
      { order: 3, type: 'heading', text: 'మీరు పంపాల్సిన సమాచారం' },
      { order: 4, type: 'paragraph', text: 'దయచేసి మీ ప్రాంతంలో కనిపించే క్రింది సమాచారం వెంటనే మాతో పంచండి:' },
      { order: 5, type: 'bullets', items: ['కొత్త షాప్ ఓపెనింగ్స్', 'కొత్త రెస్టారెంట్ / హోటల్ ప్రారంభాలు', 'కొత్త షోరూమ్స్ / బ్రాండ్ స్టోర్స్', 'ఆసుపత్రులు / క్లినిక్స్ ప్రారంభాలు'] },
    ],
    cta: { label: 'అదనపు ఆదాయం పొందడానికి', action: 'whatsapp', value: '' },
  },
};

function defaultsFor(lang) {
  const base = DEFAULTS[lang] || DEFAULTS.en;
  return JSON.parse(JSON.stringify(base));
}

// ---------------------------------------------------------------- sanitize
const str = (v, fb = '', max = 4000) => {
  const s = v == null ? '' : String(v);
  const t = s.trim().slice(0, max);
  return t || fb || '';
};
const num = (v, fb = 1) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const pick = (v, allowed, fb) => (allowed.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : fb);

function normBlock(b, i = 0) {
  const s = b && typeof b === 'object' ? b : {};
  const type = pick(s.type, BLOCK_TYPES, 'paragraph');
  const items = Array.isArray(s.items) ? s.items.map((x) => str(x, '', 300)).filter(Boolean).slice(0, MAX.bullets) : [];
  return { order: num(s.order, i + 1), type, text: str(s.text, '', 4000), items };
}
function normBlocks(list, fbList) {
  const src = Array.isArray(list) ? list : null;
  if (!src) return (fbList || []).map((b, i) => normBlock(b, i));
  return src.slice(0, MAX.blocks).map((b, i) => normBlock(b, i)).filter((b) => b.text || (b.items && b.items.length));
}

/** Merge a saved doc (may be null) over language defaults → complete content. */
function mergeDoc(doc, lang) {
  const fb = defaultsFor(lang);
  const d = doc || {};
  return {
    language: lang,
    enabled: !!d.enabled,
    banner: {
      imageUrl: str(d.banner?.imageUrl, fb.banner.imageUrl, 600),
      title: str(d.banner?.title, fb.banner.title, 160),
      subtitle: str(d.banner?.subtitle, fb.banner.subtitle, 160),
      overlaySide: pick(d.banner?.overlaySide, OVERLAY_SIDES, fb.banner.overlaySide || 'right'),
    },
    blocks: Array.isArray(d.blocks) && d.blocks.length ? normBlocks(d.blocks) : normBlocks(fb.blocks),
    cta: {
      label: str(d.cta?.label, fb.cta.label, 80),
      action: pick(d.cta?.action, CTA_ACTIONS, fb.cta.action || 'none'),
      value: str(d.cta?.value, fb.cta.value, 300),
    },
    updatedAt: d.updatedAt || null,
  };
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
    res.render('reporter-advertise', {
      title: 'Reporter Advertise Page',
      admin: req.admin,
      activePage: 'reporter-advertise',
      languages: getActiveLanguages(),
    });
  } catch (error) {
    console.error('Error rendering advertise page:', error);
    res.status(500).send('Error loading page');
  }
}

async function getAdmin(req, res) {
  try {
    const docs = await ReporterAdvertisePage.find({}).lean();
    const byLang = {};
    docs.forEach((d) => { byLang[d.language] = d; });
    // Language registry items are keyed by `.code` (not `.language`).
    const items = getActiveLanguages().map((l) => {
      const code = l.code;
      return { language: code, name: l.name || code, nativeName: l.nativeName || '', ...mergeDoc(byLang[code] || null, code) };
    });
    res.json({ success: true, items });
  } catch (error) {
    console.error('Error loading advertise admin:', error);
    res.status(500).json({ error: 'Failed to load' });
  }
}

async function updateAdmin(req, res) {
  try {
    const lang = String(req.body.language || '').trim().toLowerCase().slice(0, 8);
    if (!lang) return res.status(400).json({ error: 'language is required' });
    const merged = mergeDoc(req.body, lang);
    const update = {
      language: lang,
      enabled: !!req.body.enabled,
      banner: merged.banner,
      blocks: merged.blocks,
      cta: merged.cta,
      updatedAt: new Date(),
      updatedBy: (req.admin && (req.admin.username || req.admin.id)) || '',
    };
    const doc = await ReporterAdvertisePage.findOneAndUpdate({ language: lang }, { $set: update }, { new: true, upsert: true }).lean();
    await bustCache();
    res.json({ success: true, item: { language: lang, name: lang, ...mergeDoc(doc, lang) } });
  } catch (error) {
    console.error('Error saving advertise page:', error);
    res.status(500).json({ error: 'Failed to save' });
  }
}

async function uploadImage(req, res) {
  try {
    if (!req.file || !req.file.path) return res.status(400).json({ error: 'No image uploaded' });
    res.json({ success: true, imageUrl: req.file.path, thumbnailUrl: req.file.thumbnailPath || req.file.path });
  } catch (error) {
    console.error('Error uploading advertise image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
}

// ---------------------------------------------------------------- public
async function getPublic(req, res) {
  try {
    const lang = String(req.query.lang || 'te').trim().toLowerCase().slice(0, 8) || 'te';
    if (isRedisAvailable()) {
      const hit = await redisClient.get(cacheKey(lang)).catch(() => null);
      if (hit) { res.set('X-Cache', 'HIT'); return res.json(JSON.parse(hit)); }
    }
    const docs = await ReporterAdvertisePage.find({ language: { $in: [lang, 'en'] } }).lean();
    const byLang = {};
    docs.forEach((d) => { byLang[d.language] = d; });
    const useDoc = byLang[lang] || byLang.en || null;
    const resolvedLang = byLang[lang] ? lang : byLang.en ? 'en' : DEFAULTS[lang] ? lang : 'en';
    const content = mergeDoc(useDoc, resolvedLang);
    const payload = { success: true, lang, resolvedLang, enabled: content.enabled, content };
    if (isRedisAvailable()) redisClient.setEx(cacheKey(lang), CACHE_TTL, JSON.stringify(payload)).catch(() => {});
    res.set('X-Cache', 'MISS');
    res.json(payload);
  } catch (error) {
    console.error('Error serving public advertise page:', error);
    res.status(500).json({ success: false, error: 'Failed to load' });
  }
}

module.exports = { renderPage, getAdmin, updateAdmin, uploadImage, getPublic, mergeDoc, DEFAULTS };
