const { detectPrimaryLanguage } = require('../utils/languageUtils');

const checkLanguageMismatch = (req, res, next) => {
  const { content, category, language, ignoreLanguageWarning } = req.body;

  // If user ignored the warning and clicked proceed, bypass the check
  if (ignoreLanguageWarning === true) {
    return next();
  }

  // Bypass the language check entirely for the Reporter App
  if (req.headers['x-app-source'] === 'reporter-app') {
    return next();
  }

  // We want to detect the selected language name to compare with the detected language.
  let expectedLanguageName = null;
  try {
      const { getActiveLanguages } = require('../services/languageRegistry');
      const activeLanguages = getActiveLanguages();
      
      // 1. If language code is provided, find its name
      if (language) {
          const selectedLanguage = activeLanguages.find(l => l.code === language || l.name.toLowerCase() === language.toLowerCase());
          if (selectedLanguage) {
              expectedLanguageName = selectedLanguage.name;
          }
      }
      
      // 2. Fallback: if no valid language name found, check if category is actually a language name
      if (!expectedLanguageName && category) {
          const categoryLanguage = activeLanguages.find(l => l.name.toLowerCase() === category.toLowerCase());
          if (categoryLanguage) {
              expectedLanguageName = categoryLanguage.name;
          }
      }
  } catch (err) {
      console.error('Error in languageCheck middleware:', err);
  }

  if (!expectedLanguageName) {
    return next();
  }

  const detectedData = detectPrimaryLanguage(content);
  
  if (detectedData && detectedData.language) {
    const expectedLower = expectedLanguageName.toLowerCase();
    
    // Check if the detected language matches the expected language
    if (detectedData.language !== expectedLower) {
      return res.status(409).json({
        success: false,
        warning: true,
        message: `This content appears to be in ${detectedData.language}. You selected ${expectedLanguageName}.`,
        detectedLanguage: detectedData.language,
        expectedCategory: expectedLanguageName
      });
    }
  }

  next();
};

module.exports = { checkLanguageMismatch };
