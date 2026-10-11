/**
 * Reporter Hub (main-app "+" screen) — admin CRUD + public read.
 * Separate controller so adminController stays untouched. Everything here is
 * additive; the public endpoint is cached in Redis (60s) and busts on save.
 */
const ReporterHubContent = require('../models/ReporterHubContent');
const { redisClient, isRedisAvailable } = require('../config/redis');
const { getActiveLanguages } = require('../services/languageRegistry');

const CACHE_TTL = 60;
const cacheKey = (lang) => `reporter-hub:v1:${lang}`;
const ACTIONS = ['register', 'login', 'url', 'whatsapp', 'none'];
const THEMES = ['blue', 'gold', 'dark', 'light'];
const ICONS = ['help', 'doc', 'video', 'rupee', 'info'];
const MAX = { banners: 10, cards: 6, faq: 40, tags: 8, labels: 6 };

// ---------------------------------------------------------------- defaults
const DEFAULTS = {
  te: {
    banner: { imageUrl: '' },
    cards: [
      { order: 1, key: 'reporter', action: 'register', actionValue: '', imageUrl: '' },
      { order: 2, key: 'advertise', action: 'url', actionValue: '', imageUrl: '' },
    ],
    faq: {
      title: 'తరచుగా అడిగే ప్రశ్నలు',
      subtitle: 'మీ సందేహాలకు సరళమైన సమాధానాలు',
      seeAll: 'అన్నీ చూడండి',
      items: [
        { order: 1, q: 'తెహెల్కా న్యూస్ జర్నలిస్ట్ ఎలా అవ్వాలి?', a: '"రిపోర్టర్ అవ్వండి" కార్డ్ నొక్కి రిజిస్ట్రేషన్ ఫారమ్ నింపండి. అడ్మిన్ ఆమోదించాక మీరు వార్తలు పోస్ట్ చేయవచ్చు.', icon: 'help' },
        { order: 2, q: 'తెహెల్కా న్యూస్ కు వార్తలు ఎలా పంపాలి?', a: 'రిపోర్టర్‌గా లాగిన్ అయ్యి, మీ జిల్లా → నియోజకవర్గం → గ్రామం ఎంచుకుని వార్త రాసి సబ్మిట్ చేయండి.', icon: 'doc' },
        { order: 3, q: 'వీడియో వార్తలు ఎలా పంపాలి?', a: 'వార్త రాసేటప్పుడు వీడియో ఫైల్ జత చేయండి. చిన్న, స్పష్టమైన వీడియోలు త్వరగా ఆమోదం పొందుతాయి.', icon: 'video' },
        { order: 4, q: 'జిల్లా మరియు గ్రామాన్ని మార్చడం సాధ్యమా?', a: 'మీకు కేటాయించిన జిల్లాలోని ఏ గ్రామాన్నైనా ఎంచుకోవచ్చు. జిల్లా మార్పు కోసం అడ్మిన్‌ను సంప్రదించండి.', icon: 'rupee' },
      ],
    },
    nav: { dashboard: 'డాష్‌బోర్డ్', myStories: 'నా స్టోరీస్', myDistrict: 'నా జిల్లా', appDetails: 'యాప్ వివరాలు' },
  },
  en: {
    banner: { imageUrl: '' },
    cards: [
      { order: 1, key: 'reporter', action: 'register', actionValue: '', imageUrl: '' },
      { order: 2, key: 'advertise', action: 'url', actionValue: '', imageUrl: '' },
    ],
    faq: {
      title: 'Frequently asked questions',
      subtitle: 'Simple answers to your doubts',
      seeAll: 'See all',
      items: [
        { order: 1, q: 'How do I become a Tehelka News journalist?', a: 'Tap "Become a reporter" and fill the registration form. Once an admin approves, you can post news.', icon: 'help' },
        { order: 2, q: 'How do I send news to Tehelka News?', a: 'Log in as a reporter, pick your district → constituency → village, write the news and submit.', icon: 'doc' },
        { order: 3, q: 'How do I send video news?', a: 'Attach a video file while writing the news. Short, clear videos get approved faster.', icon: 'video' },
        { order: 4, q: 'Can I change my district or village?', a: 'You can pick any village in your assigned district. Contact the admin to change the district.', icon: 'rupee' },
      ],
    },
    nav: { dashboard: 'Dashboard', myStories: 'My Stories', myDistrict: 'My District', appDetails: 'App Details' },
  },
};

function defaultsFor(lang) {
  const base = DEFAULTS[lang] || DEFAULTS.en;
  return JSON.parse(JSON.stringify(base));
}

// ---------------------------------------------------------------- sanitize
const str = (v, fb = '', max = 500) => {
  const s = v == null ? '' : String(v);
  const t = s.trim().slice(0, max);
  return t || fb || '';
};
const num = (v, fb = 1) => (Number.isFinite(Number(v)) ? Number(v) : fb);
const pick = (v, allowed, fb) => (allowed.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : fb);
const strArr = (v, fb = [], max = 8) => {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!arr) return [...fb];
  return arr.map((x) => str(x, '', 60)).filter(Boolean).slice(0, max);
};

function normCard(c, fb = {}, i = 0) {
  const s = c && typeof c === 'object' ? c : {};
  return {
    order: num(s.order, fb.order || i + 1),
    key: str(s.key, fb.key || 'custom', 30),
    action: pick(s.action, ACTIONS, fb.action || 'none'),
    actionValue: str(s.actionValue, fb.actionValue, 300),
    imageUrl: str(s.imageUrl, fb.imageUrl, 600),
  };
}
function normFaqItem(f, fb = {}, i = 0) {
  const s = f && typeof f === 'object' ? f : {};
  return {
    order: num(s.order, fb.order || i + 1),
    q: str(s.q, fb.q, 200),
    a: str(s.a, fb.a, 2000),
    icon: pick(s.icon, ICONS, fb.icon || 'help'),
  };
}
function normList(list, fbList, normFn, max) {
  const src = Array.isArray(list) ? list : null;
  if (!src) return (fbList || []).map((x, i) => normFn(x, x, i));
  // Keep meaningful entries. FAQ items are identified by `q`; cards have no
  // title/q, so also keep any card that carries content (image/action/key) —
  // otherwise every card was silently dropped on save.
  return src.slice(0, max).map((x, i) => normFn(x, {}, i)).filter((x) => x.title || x.q || x.imageUrl || x.actionValue || x.key);
}

/** Merge a saved doc (may be null) over the language defaults → complete content. */
function mergeDoc(doc, lang) {
  const fb = defaultsFor(lang);
  const d = doc || {};
  return {
    language: lang,
    enabled: !!d.enabled,
    banner: { imageUrl: str(d.banner?.imageUrl, fb.banner?.imageUrl || '', 600) },
    cards: Array.isArray(d.cards) && d.cards.length ? d.cards.map((c, i) => normCard(c, fb.cards[i] || {}, i)) : fb.cards.map((c, i) => normCard(c, c, i)),
    faq: {
      title: str(d.faq?.title, fb.faq.title, 80),
      subtitle: str(d.faq?.subtitle, fb.faq.subtitle, 120),
      seeAll: str(d.faq?.seeAll, fb.faq.seeAll, 30),
      items: Array.isArray(d.faq?.items) && d.faq.items.length ? d.faq.items.map((f, i) => normFaqItem(f, fb.faq.items[i] || {}, i)) : fb.faq.items.map((f, i) => normFaqItem(f, f, i)),
    },
    nav: {
      dashboard: str(d.nav?.dashboard, fb.nav.dashboard, 30),
      myStories: str(d.nav?.myStories, fb.nav.myStories, 30),
      myDistrict: str(d.nav?.myDistrict, fb.nav.myDistrict, 30),
      appDetails: str(d.nav?.appDetails, fb.nav.appDetails, 30),
    },
    updatedAt: d.updatedAt || null,
  };
}

async function bustCache() {
  if (!isRedisAvailable()) return;
  try {
    const langs = new Set(['te', 'en', ...getActiveLanguages().map((l) => l.code)]);
    await Promise.all([...langs].map((l) => redisClient.del(cacheKey(l)).catch(() => {})));
  } catch (_) { /* non-fatal */ }
}

// ---------------------------------------------------------------- admin
async function renderPage(req, res) {
  try {
    res.render('reporter-hub', {
      title: 'Reporter Hub (Main App "+")',
      admin: req.admin,
      activePage: 'reporter-hub',
      languages: getActiveLanguages(),
    });
  } catch (error) {
    console.error('Error rendering reporter hub page:', error);
    res.status(500).send('Error loading page');
  }
}

async function getAdmin(req, res) {
  try {
    const languages = getActiveLanguages();
    const docs = await ReporterHubContent.find({}).lean();
    const byLang = {};
    docs.forEach((d) => { byLang[d.language] = d; });
    const items = languages.map((lang) => ({
      ...mergeDoc(byLang[lang.code], lang.code),
      name: lang.name,
      nativeName: lang.nativeName,
      isSaved: !!byLang[lang.code],
    }));
    res.json({ items, actions: ACTIONS, themes: THEMES, icons: ICONS });
  } catch (error) {
    console.error('Error fetching reporter hub content:', error);
    res.status(500).json({ error: 'Failed to fetch content' });
  }
}

async function updateAdmin(req, res) {
  try {
    const body = req.body || {};
    const code = String(body.language || '').trim().toLowerCase();
    if (!code) return res.status(400).json({ error: 'Language is required' });
    if (!getActiveLanguages().some((l) => l.code === code)) {
      return res.status(400).json({ error: 'Language is not active in admin languages' });
    }
    const fb = defaultsFor(code);
    const update = {
      language: code,
      enabled: body.enabled === true || body.enabled === 'true',
      banner: { imageUrl: str(body.banner?.imageUrl, fb.banner?.imageUrl || '', 600) },
      cards: normList(body.cards, fb.cards, normCard, MAX.cards),
      faq: {
        title: str(body.faq?.title, fb.faq.title, 80),
        subtitle: str(body.faq?.subtitle, fb.faq.subtitle, 120),
        seeAll: str(body.faq?.seeAll, fb.faq.seeAll, 30),
        items: normList(body.faq?.items, fb.faq.items, normFaqItem, MAX.faq),
      },
      nav: {
        dashboard: str(body.nav?.dashboard, fb.nav.dashboard, 30),
        myStories: str(body.nav?.myStories, fb.nav.myStories, 30),
        myDistrict: str(body.nav?.myDistrict, fb.nav.myDistrict, 30),
        appDetails: str(body.nav?.appDetails, fb.nav.appDetails, 30),
      },
      updatedBy: String(req.admin?.username || req.admin?.name || ''),
    };
    const doc = await ReporterHubContent.findOneAndUpdate({ language: code }, update, { upsert: true, new: true, setDefaultsOnInsert: true });
    await bustCache();
    res.json({ success: true, item: { ...mergeDoc(doc.toObject(), code), isSaved: true } });
  } catch (error) {
    console.error('Error updating reporter hub content:', error);
    res.status(500).json({ error: 'Failed to save content' });
  }
}

async function uploadImage(req, res) {
  try {
    if (!req.file || !req.file.path) return res.status(400).json({ error: 'No image uploaded' });
    res.json({ success: true, imageUrl: req.file.path, thumbnailUrl: req.file.thumbnailPath || req.file.path });
  } catch (error) {
    console.error('Error uploading reporter hub image:', error);
    res.status(500).json({ error: 'Failed to upload image' });
  }
}

// ---------------------------------------------------------------- public (main app)
/**
 * GET /api/public/reporter-hub?lang=te
 * → { success, enabled, lang, resolvedLang, content }
 * Fallback chain: requested language doc → English doc → built-in defaults.
 * `enabled` comes from the doc actually used; with no docs at all it is false.
 */
async function getPublic(req, res) {
  const lang = String(req.query.lang || 'te').trim().toLowerCase().slice(0, 8) || 'te';
  try {
    if (isRedisAvailable()) {
      const hit = await redisClient.get(cacheKey(lang)).catch(() => null);
      if (hit) { res.set('X-Cache', 'HIT'); return res.json(JSON.parse(hit)); }
    }
    const docs = await ReporterHubContent.find({ language: { $in: [lang, 'en'] } }).lean();
    const byLang = {};
    docs.forEach((d) => { byLang[d.language] = d; });
    const useDoc = byLang[lang] || byLang.en || null;
    const resolvedLang = byLang[lang] ? lang : byLang.en ? 'en' : DEFAULTS[lang] ? lang : 'en';
    const payload = {
      success: true,
      enabled: !!(useDoc && useDoc.enabled),
      lang,
      resolvedLang,
      content: mergeDoc(useDoc, resolvedLang),
    };
    if (isRedisAvailable()) redisClient.setEx(cacheKey(lang), CACHE_TTL, JSON.stringify(payload)).catch(() => {});
    res.set('X-Cache', 'MISS');
    res.json(payload);
  } catch (error) {
    console.error('Error serving reporter hub:', error);
    // Never break the app: serve defaults, disabled.
    res.json({ success: true, enabled: false, lang, resolvedLang: 'en', content: mergeDoc(null, DEFAULTS[lang] ? lang : 'en') });
  }
}

module.exports = { renderPage, getAdmin, updateAdmin, uploadImage, getPublic, DEFAULTS, mergeDoc };
