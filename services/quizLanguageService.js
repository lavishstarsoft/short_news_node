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
const DEFAULT_FEED_POSITION = 1;
const _base = () => ({ at: 0, langs: [], isEnabled: false, revealTime: DEFAULT_REVEAL, winnerReleaseTime: DEFAULT_WINNER_RELEASE, feedPosition: DEFAULT_FEED_POSITION });
let _cache = _base();
const _view = () => ({ langs: _cache.langs, isEnabled: _cache.isEnabled, revealTime: _cache.revealTime, winnerReleaseTime: _cache.winnerReleaseTime, feedPosition: _cache.feedPosition });

/** The configured quiz languages, master toggle, reveal/release times + feed position. Short TTL cache. */
async function getQuizConfig() {
  const fallback = { langs: [], isEnabled: false, revealTime: DEFAULT_REVEAL, winnerReleaseTime: DEFAULT_WINNER_RELEASE, feedPosition: DEFAULT_FEED_POSITION };
  if (mongoose.connection.readyState !== 1) return fallback; // no DB (e.g. tests)
  const now = Date.now();
  if (now - _cache.at < 60000) return _view();
  try {
    const s = await QuizSettings.findOne({ key: 'quiz_config' }).select('enabledLanguages isEnabled revealTime winnerReleaseTime feedPosition').lean();
    if (s) {
      _cache = {
        at: now,
        langs: Array.isArray(s.enabledLanguages) ? s.enabledLanguages : [],
        isEnabled: !!s.isEnabled,
        revealTime: s.revealTime || DEFAULT_REVEAL,
        winnerReleaseTime: s.winnerReleaseTime || DEFAULT_WINNER_RELEASE,
        feedPosition: Number.isInteger(s.feedPosition) && s.feedPosition >= 1 ? s.feedPosition : DEFAULT_FEED_POSITION,
      };
    } else {
      _cache = { ..._base(), at: now }; // Strict default
    }
  } catch (_) {
    _cache = { ..._base(), at: now };
  }
  return _view();
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
function _clearCache() { _cache = _base(); }

module.exports = { getQuizEnabledLanguages, getQuizConfig, isQuizLanguageAllowed, _clearCache };
