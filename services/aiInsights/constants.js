'use strict';

module.exports = {
  ENV_INSIGHTS_ENABLED: 'AI_INSIGHTS_ENABLED',
  ENV_INSIGHTS_SCAN_ENABLED: 'AI_INSIGHTS_SCAN_ENABLED',

  /** Cosine threshold to form a similarity edge (advisory). */
  DEFAULT_MIN_SIMILARITY: 0.88,
  /** Time window for local neighbor comparisons (hours). Avoids O(N²). */
  DEFAULT_COMPARE_WINDOW_HOURS: 72,
  /** Max live articles processed per language per full scan (safety cap). */
  DEFAULT_MAX_ARTICLES_PER_LANGUAGE: 20000,
  /** Prefer Atlas when true; local windowed cosine is always fallback. */
  DEFAULT_PREFER_ATLAS: true,
  DEFAULT_ATLAS_TOP_K: 15,
  DEFAULT_ATLAS_WINDOW_HOURS: 168,

  DEFAULT_SCAN_POLL_MS: 15 * 60 * 1000,
  DEFAULT_FULL_SCAN_COOLDOWN_MS: 60 * 60 * 1000,

  ADVISORY_DISCLAIMER:
    'These articles are semantically similar. This is editorial intelligence only — not a verdict. Final decision is always human.',

  GROUP_STATUS: {
    OPEN: 'open',
    REVIEWED: 'reviewed',
    IGNORED: 'ignored',
    ARCHIVED: 'archived',
  },

  MEMBER_ROLE: {
    ORIGINAL: 'original',
    SIMILAR: 'similar',
  },
};
