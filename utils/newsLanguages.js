const SUPPORTED_NEWS_LANGUAGES = ['te', 'en', 'hi', 'ta'];

const NEWS_LANGUAGE_LABELS = {
  te: 'Telugu',
  en: 'English',
  hi: 'Hindi',
  ta: 'Tamil'
};

function normalizeNewsLanguage(code) {
  if (!code || typeof code !== 'string') return 'te';
  const normalized = code.trim().toLowerCase();
  return SUPPORTED_NEWS_LANGUAGES.includes(normalized) ? normalized : 'te';
}

function buildNewsLanguageFilter(language) {
  const normalized = normalizeNewsLanguage(language);
  if (!normalized) return {};

  // Legacy articles without language are treated as Telugu
  if (normalized === 'te') {
    return {
      $or: [
        { language: 'te' },
        { language: { $exists: false } },
        { language: null },
        { language: '' }
      ]
    };
  }

  return { language: normalized };
}

module.exports = {
  SUPPORTED_NEWS_LANGUAGES,
  NEWS_LANGUAGE_LABELS,
  normalizeNewsLanguage,
  buildNewsLanguageFilter
};
