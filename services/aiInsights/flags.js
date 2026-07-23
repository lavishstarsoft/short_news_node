'use strict';

const C = require('./constants');

function parseBool(raw) {
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function isAiInsightsEnabled(env = process.env) {
  return parseBool(env[C.ENV_INSIGHTS_ENABLED]);
}

function isAiInsightsScanEnabled(env = process.env) {
  return parseBool(env[C.ENV_INSIGHTS_SCAN_ENABLED]);
}

function loadInsightsConfig(env = process.env) {
  const minSimilarity = Number.parseFloat(env.AI_INSIGHTS_MIN_SIMILARITY);
  const windowHours = Number.parseInt(env.AI_INSIGHTS_COMPARE_WINDOW_HOURS, 10);
  const maxPerLang = Number.parseInt(env.AI_INSIGHTS_MAX_PER_LANGUAGE, 10);
  const atlasTopK = Number.parseInt(env.AI_INSIGHTS_ATLAS_TOP_K, 10);
  const atlasWindow = Number.parseInt(env.AI_INSIGHTS_ATLAS_WINDOW_HOURS, 10);
  const pollMs = Number.parseInt(env.AI_INSIGHTS_SCAN_POLL_MS, 10);
  const cooldownMs = Number.parseInt(env.AI_INSIGHTS_FULL_SCAN_COOLDOWN_MS, 10);

  return {
    enabled: isAiInsightsEnabled(env),
    scanEnabled: isAiInsightsScanEnabled(env),
    minSimilarity: Number.isFinite(minSimilarity)
      ? minSimilarity
      : C.DEFAULT_MIN_SIMILARITY,
    compareWindowHours: Number.isFinite(windowHours) && windowHours > 0
      ? windowHours
      : C.DEFAULT_COMPARE_WINDOW_HOURS,
    maxArticlesPerLanguage: Number.isFinite(maxPerLang) && maxPerLang > 0
      ? maxPerLang
      : C.DEFAULT_MAX_ARTICLES_PER_LANGUAGE,
    preferAtlas: env.AI_INSIGHTS_PREFER_ATLAS !== 'false',
    atlasTopK: Number.isFinite(atlasTopK) && atlasTopK > 0
      ? atlasTopK
      : C.DEFAULT_ATLAS_TOP_K,
    atlasWindowHours: Number.isFinite(atlasWindow) && atlasWindow > 0
      ? atlasWindow
      : C.DEFAULT_ATLAS_WINDOW_HOURS,
    scanPollMs: Number.isFinite(pollMs) && pollMs > 0
      ? pollMs
      : C.DEFAULT_SCAN_POLL_MS,
    fullScanCooldownMs: Number.isFinite(cooldownMs) && cooldownMs > 0
      ? cooldownMs
      : C.DEFAULT_FULL_SCAN_COOLDOWN_MS,
    disclaimer: C.ADVISORY_DISCLAIMER,
  };
}

module.exports = {
  isAiInsightsEnabled,
  isAiInsightsScanEnabled,
  loadInsightsConfig,
};
