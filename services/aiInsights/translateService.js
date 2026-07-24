'use strict';

/**
 * UI-only translation for AI Insights compare modal.
 * Does not mutate articles. Optional GOOGLE_TRANSLATE_API_KEY; else MyMemory.
 */

const ALLOWED = new Set(['en', 'hi', 'te']);

const memoryCache = new Map();
const MAX_CACHE = 500;

function cacheKey(text, target, source) {
  return `${source || 'auto'}|${target}|${text}`;
}

function getCached(text, target, source) {
  return memoryCache.get(cacheKey(text, target, source));
}

function setCached(text, target, source, value) {
  if (memoryCache.size >= MAX_CACHE) {
    const first = memoryCache.keys().next().value;
    memoryCache.delete(first);
  }
  memoryCache.set(cacheKey(text, target, source), value);
}

async function translateWithGoogle(text, target, source) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!key) return null;
  const params = new URLSearchParams({
    key,
    q: text,
    target,
    format: 'text',
  });
  if (source && source !== 'auto') params.set('source', source);
  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2?${params.toString()}`,
    { method: 'POST' }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data?.data?.translations?.[0]?.translatedText || null;
}

async function translateWithMyMemory(text, target, source) {
  const pair = `${source && source !== 'auto' ? source : 'autodetect'}|${target}`;
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
    text.slice(0, 450)
  )}&langpair=${encodeURIComponent(pair)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('translate_upstream');
  const data = await res.json();
  const out = data?.responseData?.translatedText;
  if (!out) throw new Error('translate_empty');
  return out;
}

async function translateOne(text, targetLang, sourceLang = 'auto') {
  const target = String(targetLang || '').toLowerCase();
  if (!ALLOWED.has(target)) {
    throw new Error('unsupported_language');
  }
  const raw = text == null ? '' : String(text);
  if (!raw.trim()) return '';

  const cached = getCached(raw, target, sourceLang);
  if (cached != null) return cached;

  let translated = await translateWithGoogle(raw, target, sourceLang);
  if (translated == null) {
    translated = await translateWithMyMemory(raw, target, sourceLang);
  }
  setCached(raw, target, sourceLang, translated);
  return translated;
}

async function translateTexts(texts, targetLang, sourceLang = 'auto') {
  const list = Array.isArray(texts) ? texts : [];
  const out = [];
  for (const t of list) {
    // Sequential to respect free-tier rate limits
    // eslint-disable-next-line no-await-in-loop
    out.push(await translateOne(t, targetLang, sourceLang));
  }
  return out;
}

module.exports = {
  ALLOWED,
  translateOne,
  translateTexts,
};
