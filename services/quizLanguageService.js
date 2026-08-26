'use strict';

/**
 * Quiz language targeting — Uses QuizSettings.enabledLanguages array
 * (same multi-language pattern as calendar/zodiac). The quiz is gated at the
 * Quiz/week level (feed card + entry point), NOT per-question: random assignment,
 * answers, weekly progress and winners are untouched. Empty list = all languages.
 */

const mongoose = require('mongoose');
const QuizSettings = require('../models/QuizSettings');

const DEFAULT_REVEAL = '23:30';
const DEFAULT_WINNER_RELEASE = '10:00';
let _cache = { at: 0, langs: [], isEnabled: false, revealTime: DEFAULT_REVEAL, winnerReleaseTime: DEFAULT_WINNER_RELEASE };

/** The configured quiz languages, master toggle, and reveal/release times. Short TTL cache. */
async function getQuizConfig() {
  const fallback = { langs: [], isEnabled: false, revealTime: DEFAULT_REVEAL, winnerReleaseTime: DEFAULT_WINNER_RELEASE };
  if (mongoose.connection.readyState !== 1) return fallback; // no DB (e.g. tests)
  const now = Date.now();
  if (now - _cache.at < 60000) return { langs: _cache.langs, isEnabled: _cache.isEnabled, revealTime: _cache.revealTime, winnerReleaseTime: _cache.winnerReleaseTime };
  try {
    const s = await QuizSettings.findOne({ key: 'quiz_config' }).select('enabledLanguages isEnabled revealTime winnerReleaseTime').lean();
    if (s) {
      _cache = {
        at: now,
        langs: Array.isArray(s.enabledLanguages) ? s.enabledLanguages : [],
        isEnabled: !!s.isEnabled,
        revealTime: s.revealTime || DEFAULT_REVEAL,
        winnerReleaseTime: s.winnerReleaseTime || DEFAULT_WINNER_RELEASE,
      };
    } else {
      _cache = { at: now, langs: [], isEnabled: false, revealTime: DEFAULT_REVEAL, winnerReleaseTime: DEFAULT_WINNER_RELEASE }; // Strict default
    }
  } catch (_) {
    _cache = { at: now, langs: [], isEnabled: false, revealTime: DEFAULT_REVEAL, winnerReleaseTime: DEFAULT_WINNER_RELEASE };
  }
  return { langs: _cache.langs, isEnabled: _cache.isEnabled, revealTime: _cache.revealTime, winnerReleaseTime: _cache.winnerReleaseTime };
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
function _clearCache() { _cache = { at: 0, langs: [], isEnabled: false, revealTime: DEFAULT_REVEAL, winnerReleaseTime: DEFAULT_WINNER_RELEASE }; }

module.exports = { getQuizEnabledLanguages, getQuizConfig, isQuizLanguageAllowed, _clearCache };
