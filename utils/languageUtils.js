// Language Detection Utility based on Unicode Ranges
const mongoose = require('mongoose');

// Default fallback ranges for core languages
let languageRanges = {
  telugu: /[\u0C00-\u0C7F]/g,
  hindi: /[\u0900-\u097F]/g, // Devanagari
  tamil: /[\u0B80-\u0BFF]/g,
  kannada: /[\u0C80-\u0CFF]/g,
  malayalam: /[\u0D00-\u0D7F]/g,
  english: /[A-Za-z]/g
};

// Function to refresh ranges from the database
async function refreshLanguageRanges() {
  try {
    const Language = mongoose.models.Language || mongoose.model('Language');
    const languages = await Language.find({ isActive: true });
    
    let newRanges = {
      english: /[A-Za-z]/g // Always keep English as fallback
    };

    languages.forEach(lang => {
      const codeName = lang.name.toLowerCase();
      if (lang.unicodeRange) {
        try {
          // Construct regex from string. Ensure we handle escaped characters properly.
          // The database will store something like \u0D00-\u0D7F
          const regexStr = `[${lang.unicodeRange}]`;
          newRanges[codeName] = new RegExp(regexStr, 'g');
        } catch (e) {
          console.error(`Invalid unicode range for language ${lang.name}:`, e);
        }
      }
    });

    // Merge with defaults if dynamic ranges are empty (to prevent breaking)
    languageRanges = { ...languageRanges, ...newRanges };
    console.log('Language unicode ranges refreshed successfully.');
  } catch (error) {
    console.error('Error refreshing language ranges:', error);
  }
}

function detectPrimaryLanguage(text) {
  if (!text) return null;

  // Remove spaces, numbers, and special characters to count only actual letters
  const textWithoutSpaces = text.replace(/[\s0-9!@#$%^&*()_+.,?":{}|<>\[\]]/g, "");
  const totalChars = textWithoutSpaces.length;

  if (totalChars === 0) return 'english'; // Default fallback

  let languageCounts = {};

  // Count characters for each language
  for (const [lang, regex] of Object.entries(languageRanges)) {
    const matches = textWithoutSpaces.match(regex);
    if (matches) {
      languageCounts[lang] = matches.length;
    }
  }

  let maxPercentage = 0;
  let primaryLanguage = 'english'; // Default fallback

  // Find the language with the highest percentage
  for (const [lang, count] of Object.entries(languageCounts)) {
    const percentage = (count / totalChars) * 100;
    
    // Ignore english if a local language is dominating (even slightly), 
    // or just rely on absolute max. Here we rely on max.
    if (percentage > maxPercentage) {
      maxPercentage = percentage;
      primaryLanguage = lang;
    }
  }

  return {
    language: primaryLanguage,
    percentages: languageCounts 
  };
}

module.exports = { detectPrimaryLanguage, languageRanges, refreshLanguageRanges };
