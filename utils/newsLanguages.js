const registry = require('../services/languageRegistry');

Object.defineProperty(exports, 'SUPPORTED_NEWS_LANGUAGES', {
  enumerable: true,
  get() {
    return registry.getSupportedCodes();
  }
});

Object.defineProperty(exports, 'NEWS_LANGUAGE_LABELS', {
  enumerable: true,
  get() {
    return registry.getLabelsMap();
  }
});

exports.normalizeNewsLanguage = registry.normalizeNewsLanguage;
exports.buildNewsLanguageFilter = registry.buildNewsLanguageFilter;
exports.refreshLanguageCache = registry.refreshCache;
exports.getLanguageViewData = registry.getLanguageViewData;
