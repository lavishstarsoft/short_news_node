const Language = require('../models/Language');
const {
  mergeDisplayConfig,
  getDefaultDisplayConfig,
} = require('./newsDisplayConfig');

const DEFAULT_LANGUAGES = [
  {
    code: 'te',
    name: 'Telugu',
    nativeName: 'తెలుగు',
    isActive: true,
    showInUserApp: true,
    isDefault: true,
    sortOrder: 0
  },
  {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    isActive: true,
    showInUserApp: true,
    isDefault: false,
    sortOrder: 1
  },
  {
    code: 'hi',
    name: 'Hindi',
    nativeName: 'हिंदी',
    isActive: true,
    showInUserApp: true,
    isDefault: false,
    sortOrder: 2
  },
  {
    code: 'ta',
    name: 'Tamil',
    nativeName: 'தமிழ்',
    isActive: true,
    showInUserApp: true,
    isDefault: false,
    sortOrder: 3
  }
];

function buildCacheFromList(languages) {
  const sorted = [...languages].sort((a, b) => {
    const orderDiff = (a.sortOrder || 0) - (b.sortOrder || 0);
    if (orderDiff !== 0) return orderDiff;
    return String(a.name || a.code).localeCompare(String(b.name || b.code));
  });

  const labels = {};
  const supportedCodes = [];

  sorted.forEach((language) => {
    if (!language.isActive) return;
    labels[language.code] = language.name;
    supportedCodes.push(language.code);
  });

  const displayConfigByCode = {};
  sorted.forEach((language) => {
    displayConfigByCode[language.code] = mergeDisplayConfig(
      language.displayConfig,
      language.code
    );
  });

  const defaultLanguage =
    sorted.find((language) => language.isActive && language.isDefault) ||
    sorted.find((language) => language.isActive) ||
    DEFAULT_LANGUAGES[0];

  return {
    languages: sorted,
    labels,
    supportedCodes,
    defaultCode: defaultLanguage.code,
    displayConfigByCode,
    userAppLanguages: sorted.filter(
      (language) => language.isActive && language.showInUserApp
    )
  };
}

let _cache = buildCacheFromList(DEFAULT_LANGUAGES);
let _refreshPromise = null;

function getSupportedCodes() {
  return _cache.supportedCodes;
}

function getLabelsMap() {
  return { ..._cache.labels };
}

function getDefaultLanguageCode() {
  return _cache.defaultCode || 'te';
}

function getActiveLanguages() {
  return _cache.languages.filter((language) => language.isActive);
}

function getDisplayConfigForCode(code) {
  const normalized = String(code || 'te').trim().toLowerCase();
  if (_cache.displayConfigByCode?.[normalized]) {
    return _cache.displayConfigByCode[normalized];
  }
  return getDefaultDisplayConfig(normalized);
}

function getDisplayConfigMap() {
  return { ...(_cache.displayConfigByCode || {}) };
}

function getUserAppLanguages() {
  return _cache.userAppLanguages;
}

function normalizeNewsLanguage(code) {
  const defaultCode = getDefaultLanguageCode();
  if (!code || typeof code !== 'string') return defaultCode;
  const normalized = code.trim().toLowerCase();
  return getSupportedCodes().includes(normalized) ? normalized : defaultCode;
}

function buildNewsLanguageFilter(language) {
  const normalized = normalizeNewsLanguage(language);
  if (!normalized) return {};

  const defaultCode = getDefaultLanguageCode();
  if (normalized === defaultCode) {
    return {
      $or: [
        { language: defaultCode },
        { language: { $exists: false } },
        { language: null },
        { language: '' }
      ]
    };
  }

  return { language: normalized };
}

async function refreshCache() {
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    try {
      const count = await Language.countDocuments();
      if (count === 0) {
        _cache = buildCacheFromList(DEFAULT_LANGUAGES);
        return _cache;
      }

      const languages = await Language.find().sort({ sortOrder: 1, name: 1 }).lean();
      _cache = buildCacheFromList(
        languages.map((language) => ({
          code: language.code,
          name: language.name,
          nativeName: language.nativeName,
          isActive: language.isActive !== false,
          showInUserApp: language.showInUserApp !== false,
          isDefault: language.isDefault === true,
          sortOrder: language.sortOrder || 0,
          displayConfig: language.displayConfig,
          _id: language._id
        }))
      );
      return _cache;
    } catch (error) {
      console.error('Failed to refresh language cache, using defaults:', error.message);
      _cache = buildCacheFromList(DEFAULT_LANGUAGES);
      return _cache;
    } finally {
      _refreshPromise = null;
    }
  })();

  return _refreshPromise;
}

async function seedDefaultLanguages() {
  try {
    const count = await Language.countDocuments();
    if (count > 0) {
      return refreshCache();
    }

    await Language.insertMany(DEFAULT_LANGUAGES);
    console.log('Seeded default news languages');
    return refreshCache();
  } catch (error) {
    console.error('Failed to seed default languages:', error.message);
    _cache = buildCacheFromList(DEFAULT_LANGUAGES);
    return _cache;
  }
}

async function syncReporterDefaultLanguages() {
  try {
    const Admin = require('../models/Admin');
    await refreshCache();
    const defaultCode = getDefaultLanguageCode();

    const result = await Admin.updateMany(
      {
        role: { $in: ['editor', 'subeditor'] },
        $or: [
          { workingLanguage: { $exists: false } },
          { workingLanguage: null },
          { workingLanguage: '' }
        ]
      },
      { $set: { workingLanguage: defaultCode } }
    );

    if (result.modifiedCount > 0) {
      console.log(
        `Synced workingLanguage="${defaultCode}" for ${result.modifiedCount} reporter(s)`
      );
    }

    return {
      modifiedCount: result.modifiedCount,
      defaultCode
    };
  } catch (error) {
    console.error('Failed to sync reporter default languages:', error.message);
    return { modifiedCount: 0, defaultCode: getDefaultLanguageCode(), error: error.message };
  }
}

async function getLanguageViewData() {
  await refreshCache();
  return {
    languageOptions: getActiveLanguages(),
    newsLanguageLabels: getLabelsMap(),
    defaultLanguage: getDefaultLanguageCode()
  };
}

function invalidateCache() {
  _refreshPromise = null;
}

module.exports = {
  DEFAULT_LANGUAGES,
  getSupportedCodes,
  getLabelsMap,
  getDefaultLanguageCode,
  getActiveLanguages,
  getUserAppLanguages,
  getDisplayConfigForCode,
  getDisplayConfigMap,
  normalizeNewsLanguage,
  buildNewsLanguageFilter,
  refreshCache,
  seedDefaultLanguages,
  syncReporterDefaultLanguages,
  getLanguageViewData,
  invalidateCache
};
