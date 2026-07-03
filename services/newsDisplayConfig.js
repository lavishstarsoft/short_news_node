const Language = require('../models/Language');
const {
  NEWS_TITLE_MAX,
  NEWS_CONTENT_MAX,
} = require('../constants/newsLimits');

const BASE_DEFAULTS = {
  titleMax: NEWS_TITLE_MAX,
  contentMax: NEWS_CONTENT_MAX,
  contentMin: 0,
  titleFontSize: 20,
  contentFontSize: 18,
  titleLineHeight: 1.3,
  contentLineHeight: 1.6,
};

const ENGLISH_FONT_DEFAULTS = {
  titleFontSize: 18,
  contentFontSize: 16,
};

function getDefaultDisplayConfig(languageCode) {
  const code = String(languageCode || 'te').trim().toLowerCase();
  if (code === 'en') {
    return { ...BASE_DEFAULTS, ...ENGLISH_FONT_DEFAULTS };
  }
  return { ...BASE_DEFAULTS };
}

function normalizeNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeDisplayConfig(input, languageCode) {
  const defaults = getDefaultDisplayConfig(languageCode);
  const source = input && typeof input === 'object' ? input : {};

  return {
    titleMax: normalizeNumber(source.titleMax, defaults.titleMax, 20, 120),
    contentMax: normalizeNumber(source.contentMax, defaults.contentMax, 80, 1200),
    contentMin: normalizeNumber(source.contentMin, defaults.contentMin, 0, 1000),
    titleFontSize: normalizeNumber(source.titleFontSize, defaults.titleFontSize, 10, 32),
    contentFontSize: normalizeNumber(source.contentFontSize, defaults.contentFontSize, 10, 32),
    titleLineHeight: normalizeNumber(source.titleLineHeight, defaults.titleLineHeight, 1, 2.5),
    contentLineHeight: normalizeNumber(source.contentLineHeight, defaults.contentLineHeight, 1, 2.5),
  };
}

function mergeDisplayConfig(stored, languageCode) {
  return sanitizeDisplayConfig(stored, languageCode);
}

async function getDisplayConfigForLanguage(languageCode) {
  const code = String(languageCode || 'te').trim().toLowerCase();
  try {
    const language = await Language.findOne({ code }).select('displayConfig code').lean();
    if (language?.displayConfig) {
      return mergeDisplayConfig(language.displayConfig, code);
    }
  } catch (error) {
    console.error('getDisplayConfigForLanguage error:', error.message);
  }
  return getDefaultDisplayConfig(code);
}

async function getAllDisplayConfigsMap() {
  const map = {};
  try {
    const languages = await Language.find().select('code displayConfig').lean();
    for (const language of languages) {
      map[language.code] = mergeDisplayConfig(language.displayConfig, language.code);
    }
  } catch (error) {
    console.error('getAllDisplayConfigsMap error:', error.message);
  }

  if (Object.keys(map).length === 0) {
    ['te', 'en', 'hi', 'ta'].forEach((code) => {
      map[code] = getDefaultDisplayConfig(code);
    });
  }

  return map;
}

async function getPublicDisplayConfigs() {
  const map = await getAllDisplayConfigsMap();
  return Object.entries(map).map(([code, config]) => ({
    code,
    ...config,
  }));
}

module.exports = {
  BASE_DEFAULTS,
  getDefaultDisplayConfig,
  sanitizeDisplayConfig,
  mergeDisplayConfig,
  getDisplayConfigForLanguage,
  getAllDisplayConfigsMap,
  getPublicDisplayConfigs,
};
