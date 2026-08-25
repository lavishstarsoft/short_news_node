'use strict';

/**
 * Quiz language targeting — Uses QuizSettings.enabledLanguages array
 * (same multi-language pattern as calendar/zodiac). The quiz is gated at the
 * Quiz/week level (feed card + entry point), NOT per-question: random assignment,
 * answers, weekly progress and winners are untouched. Empty list = all languages.
 */

const mongoose = require('mongoose');
const QuizSettings = require('../models/QuizSettings');

let _cache = { at: 0, langs: [], isEnabled: false }; // default to OFF

/** The configured quiz languages and master toggle. Short TTL cache. */
async function getQuizConfig() {
  if (mongoose.connection.readyState !== 1) return { langs: [], isEnabled: false }; // no DB (e.g. tests)
  const now = Date.now();
  if (now - _cache.at < 60000) return { langs: _cache.langs, isEnabled: _cache.isEnabled };
  try {
    const s = await QuizSettings.findOne({ key: 'quiz_config' }).select('enabledLanguages isEnabled').lean();
    if (s) {
      _cache = { at: now, langs: Array.isArray(s.enabledLanguages) ? s.enabledLanguages : [], isEnabled: !!s.isEnabled };
    } else {
      _cache = { at: now, langs: [], isEnabled: false }; // Strict default
    }
  } catch (_) {
    _cache = { at: now, langs: [], isEnabled: false };
  }
  return { langs: _cache.langs, isEnabled: _cache.isEnabled };
}

/** Legacy export for tests/callers that only expect languages. */
async function getQuizEnabledLanguages() {
  const config = await getQuizConfig();
  return config.langs;
}

/** Pure any-match. Empty array = NO LANGUAGES (never all). Case-insensitive. Checks master toggle. */
function isQuizLanguageAllowed(lang, enabled, isEnabled = true) {
  if (isEnabled === false) return false; // Master switch is off
  if (!Array.isArray(enabled) || enabled.length === 0) return false; // empty = none
  if (!lang) return false; // missing user language = blocked
  const norm = String(lang).trim().toLowerCase();
  return enabled.map((x) => String(x).trim().toLowerCase()).includes(norm);
}

/** Test/maintenance seam. */
function _clearCache() { _cache = { at: 0, langs: [], isEnabled: false }; }

module.exports = { getQuizEnabledLanguages, getQuizConfig, isQuizLanguageAllowed, _clearCache };
