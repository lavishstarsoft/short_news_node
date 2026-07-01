const Language = require('../models/Language');
const News = require('../models/News');
const Admin = require('../models/Admin');
const {
  refreshCache,
  invalidateCache,
  syncReporterDefaultLanguages
} = require('../services/languageRegistry');
const { clearCache } = require('../middleware/cache');

const { detectPrimaryLanguage, refreshLanguageRanges } = require('../utils/languageUtils');

async function clearLanguageCaches() {
  invalidateCache();
  await refreshCache();
  await clearCache('cache:/api/public/languages*');
  await clearCache('cache:/api/public/news-display-config*');
  
  // Also refresh the dynamic Unicode ranges for language detection
  if (typeof refreshLanguageRanges === 'function') {
    await refreshLanguageRanges();
  }
}

function normalizeCode(code) {
  return String(code || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

exports.getAllLanguages = async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;

    if (!isConnectedToMongoDB) {
      await refreshCache();
      const { getActiveLanguages, getLabelsMap, getDefaultLanguageCode } = require('../services/languageRegistry');
      return res.json(
        getActiveLanguages().map((language) => ({
          ...language,
          newsCount: 0,
          editorCount: 0,
          subeditorCount: 0,
          reporterCount: 0,
          reporters: []
        }))
      );
    }

    const languages = await Language.find().sort({ sortOrder: 1, name: 1 }).lean();
    const languagesWithCounts = await Promise.all(
      languages.map(async (language) => {
        const reporterQuery = {
          role: { $in: ['editor', 'subeditor'] },
          workingLanguage: language.code
        };

        const [newsCount, reporters] = await Promise.all([
          News.countDocuments({ language: language.code }),
          Admin.find(reporterQuery)
            .select('username name displayRole role workingLanguage')
            .sort({ name: 1, username: 1 })
            .lean()
        ]);

        const editors = reporters.filter((reporter) => reporter.role === 'editor');
        const subeditors = reporters.filter((reporter) => reporter.role === 'subeditor');

        return {
          ...language,
          newsCount,
          editorCount: editors.length,
          subeditorCount: subeditors.length,
          reporterCount: reporters.length,
          reporters: reporters.map((reporter) => ({
            id: reporter._id,
            username: reporter.username,
            name: reporter.name || reporter.username,
            displayRole: reporter.displayRole || (reporter.role === 'subeditor' ? 'Sub Editor' : 'Reporter'),
            role: reporter.role
          }))
        };
      })
    );

    res.json(languagesWithCounts);
  } catch (error) {
    console.error('Error fetching languages:', error);
    res.status(500).json({ error: 'Error fetching languages' });
  }
};

exports.getLanguageById = async (req, res) => {
  try {
    const language = await Language.findById(req.params.id);
    if (!language) {
      return res.status(404).json({ error: 'Language not found' });
    }

    res.json(language);
  } catch (error) {
    console.error('Error fetching language:', error);
    res.status(500).json({ error: 'Error fetching language' });
  }
};

exports.createLanguage = async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    if (!isConnectedToMongoDB) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const code = normalizeCode(req.body.code);
    const name = String(req.body.name || '').trim();
    const nativeName = String(req.body.nativeName || '').trim();
    const sortOrder = Number(req.body.sortOrder || 0);
    const isActive = req.body.isActive !== false && req.body.isActive !== 'false';
    const showInUserApp =
      req.body.showInUserApp !== false && req.body.showInUserApp !== 'false';
    const isDefault = req.body.isDefault === true || req.body.isDefault === 'true';

    const unicodeRange = String(req.body.unicodeRange || '').trim();

    if (!code || code.length < 2) {
      return res.status(400).json({ error: 'Language code must be at least 2 characters' });
    }
    if (!name) {
      return res.status(400).json({ error: 'Language name is required' });
    }
    if (!nativeName) {
      return res.status(400).json({ error: 'Native name is required' });
    }

    const existing = await Language.findOne({ code });
    if (existing) {
      return res.status(400).json({ error: 'Language code already exists' });
    }

    if (isDefault) {
      await Language.updateMany({}, { $set: { isDefault: false } });
    }

    const language = new Language({
      code,
      name,
      nativeName,
      unicodeRange,
      sortOrder,
      isActive,
      showInUserApp,
      isDefault
    });

    await language.save();
    await clearLanguageCaches();

    res.status(201).json(language);
  } catch (error) {
    console.error('Error creating language:', error);
    res.status(500).json({ error: 'Error creating language' });
  }
};

exports.updateLanguage = async (req, res) => {
  try {
    const language = await Language.findById(req.params.id);
    if (!language) {
      return res.status(404).json({ error: 'Language not found' });
    }

    const previousCode = language.code;

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) {
        return res.status(400).json({ error: 'Language name is required' });
      }
      language.name = name;
    }

    if (req.body.nativeName !== undefined) {
      const nativeName = String(req.body.nativeName).trim();
      if (!nativeName) {
        return res.status(400).json({ error: 'Native name is required' });
      }
      language.nativeName = nativeName;
    }

    if (req.body.unicodeRange !== undefined) {
      language.unicodeRange = String(req.body.unicodeRange).trim();
    }

    if (req.body.sortOrder !== undefined) {
      language.sortOrder = Number(req.body.sortOrder || 0);
    }

    if (req.body.isActive !== undefined) {
      language.isActive =
        req.body.isActive !== false && req.body.isActive !== 'false';
    }

    if (req.body.showInUserApp !== undefined) {
      language.showInUserApp =
        req.body.showInUserApp !== false && req.body.showInUserApp !== 'false';
    }

    if (req.body.code !== undefined) {
      const code = normalizeCode(req.body.code);
      if (!code || code.length < 2) {
        return res.status(400).json({ error: 'Language code must be at least 2 characters' });
      }
      if (code !== language.code) {
        const duplicate = await Language.findOne({ code });
        if (duplicate) {
          return res.status(400).json({ error: 'Language code already exists' });
        }
        language.code = code;
      }
    }

    const wantsDefault =
      req.body.isDefault === true || req.body.isDefault === 'true';
    if (wantsDefault) {
      await Language.updateMany({}, { $set: { isDefault: false } });
      language.isDefault = true;
      language.isActive = true;
    } else if (req.body.isDefault !== undefined) {
      language.isDefault = false;
    }

    if (language.isDefault && !language.isActive) {
      return res.status(400).json({ error: 'Default language must remain active' });
    }

    await language.save();

    if (previousCode !== language.code) {
      await Promise.all([
        News.updateMany({ language: previousCode }, { $set: { language: language.code } }),
        Admin.updateMany({ workingLanguage: previousCode }, { $set: { workingLanguage: language.code } })
      ]);
    }

    await clearLanguageCaches();
    res.json(language);
  } catch (error) {
    console.error('Error updating language:', error);
    res.status(500).json({ error: 'Error updating language' });
  }
};

exports.deleteLanguage = async (req, res) => {
  try {
    const language = await Language.findById(req.params.id);
    if (!language) {
      return res.status(404).json({ error: 'Language not found' });
    }

    if (language.isDefault) {
      return res.status(400).json({ error: 'Cannot delete the default language' });
    }

    const [newsCount, reporterCount] = await Promise.all([
      News.countDocuments({ language: language.code }),
      Admin.countDocuments({
        role: { $in: ['editor', 'subeditor'] },
        workingLanguage: language.code
      })
    ]);

    if (newsCount > 0 || reporterCount > 0) {
      return res.status(400).json({
        error: `Cannot delete language in use (${newsCount} news, ${reporterCount} reporters)`
      });
    }

    await Language.findByIdAndDelete(req.params.id);
    await clearLanguageCaches();
    res.json({ message: 'Language deleted successfully' });
  } catch (error) {
    console.error('Error deleting language:', error);
    res.status(500).json({ error: 'Error deleting language' });
  }
};

exports.toggleLanguageStatus = async (req, res) => {
  try {
    const language = await Language.findById(req.params.id);
    if (!language) {
      return res.status(404).json({ error: 'Language not found' });
    }

    if (language.isDefault && language.isActive) {
      return res.status(400).json({ error: 'Default language cannot be deactivated' });
    }

    language.isActive = !language.isActive;
    await language.save();
    await clearLanguageCaches();
    res.json(language);
  } catch (error) {
    console.error('Error toggling language status:', error);
    res.status(500).json({ error: 'Error toggling language status' });
  }
};

exports.setDefaultLanguage = async (req, res) => {
  try {
    const language = await Language.findById(req.params.id);
    if (!language) {
      return res.status(404).json({ error: 'Language not found' });
    }

    await Language.updateMany({}, { $set: { isDefault: false } });
    language.isDefault = true;
    language.isActive = true;
    await language.save();
    await clearLanguageCaches();
    res.json(language);
  } catch (error) {
    console.error('Error setting default language:', error);
    res.status(500).json({ error: 'Error setting default language' });
  }
};

exports.syncReporterLanguages = async (req, res) => {
  try {
    const isConnectedToMongoDB = req.app.locals.isConnectedToMongoDB;
    if (!isConnectedToMongoDB) {
      return res.status(503).json({ error: 'Database not connected' });
    }

    const result = await syncReporterDefaultLanguages();
    res.json({
      message: result.modifiedCount > 0
        ? `Updated ${result.modifiedCount} reporter(s) to ${result.defaultCode}`
        : 'All reporters already have a language assigned',
      ...result
    });
  } catch (error) {
    console.error('Error syncing reporter languages:', error);
    res.status(500).json({ error: 'Error syncing reporter languages' });
  }
};

exports.getDisplayConfigs = async (req, res) => {
  try {
    const { getDisplayConfigMap } = require('../services/languageRegistry');
    await refreshCache();
    res.json(getDisplayConfigMap());
  } catch (error) {
    console.error('Error fetching display configs:', error);
    res.status(500).json({ error: 'Error fetching display configs' });
  }
};

exports.updateDisplayConfig = async (req, res) => {
  try {
    if (req.admin?.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super admin only' });
    }

    const language = await Language.findById(req.params.id);
    if (!language) {
      return res.status(404).json({ error: 'Language not found' });
    }

    const { sanitizeDisplayConfig } = require('../services/newsDisplayConfig');
    language.displayConfig = sanitizeDisplayConfig(req.body, language.code);
    await language.save();
    await clearLanguageCaches();

    res.json({
      code: language.code,
      displayConfig: language.displayConfig,
    });
  } catch (error) {
    console.error('Error updating display config:', error);
    res.status(500).json({ error: 'Error updating display config' });
  }
};
