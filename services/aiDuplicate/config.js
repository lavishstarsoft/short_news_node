'use strict';

const C = require('./constants');
const { loadFeatureFlag } = require('./featureFlag');
const { AiDuplicateError } = require('./errors');

function parsePositiveInt(raw, fallback) {
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * AI configuration loader (env-based). Safe to call when AI is disabled.
 */
function loadAiConfig(env = process.env) {
  const flag = loadFeatureFlag(env);
  const baseUrl = String(env[C.ENV_SERVICE_URL] || C.DEFAULT_SERVICE_URL)
    .trim()
    .replace(/\/$/, '');
  const apiKey = String(env[C.ENV_API_KEY] || '').trim();
  // Prefer env; default 12s for media cascade. Cap only at MAX (not at default).
  const timeoutMs = Math.min(
    parsePositiveInt(env[C.ENV_TIMEOUT_MS], C.DEFAULT_TIMEOUT_MS),
    C.MAX_TIMEOUT_MS
  );
  const readyTimeoutMs = parsePositiveInt(
    env[C.ENV_READY_TIMEOUT_MS],
    C.DEFAULT_READY_TIMEOUT_MS
  );

  return {
    enabled: flag.enabled,
    flag,
    baseUrl,
    apiKey,
    timeoutMs,
    readyTimeoutMs,
    loadedAt: new Date().toISOString(),
  };
}

/**
 * Environment validation.
 * - When AI disabled: always { ok: true, skipped: true } (production silent).
 * - When AI enabled: require URL + non-placeholder API key.
 *
 * @param {object} [options]
 * @param {boolean} [options.strict] force validate even if disabled
 * @param {object} [options.env]
 */
function validateAiEnvironment(options = {}) {
  const env = options.env || process.env;
  const strict = options.strict === true;
  const config = loadAiConfig(env);

  if (!config.enabled && !strict) {
    return {
      ok: true,
      skipped: true,
      enabled: false,
      issues: [],
      config: sanitizeConfig(config),
    };
  }

  const issues = [];

  if (!config.baseUrl) {
    issues.push('AI_SERVICE_URL is empty');
  } else {
    try {
      const u = new URL(config.baseUrl);
      if (!['http:', 'https:'].includes(u.protocol)) {
        issues.push('AI_SERVICE_URL must be http or https');
      }
    } catch (_) {
      issues.push('AI_SERVICE_URL is not a valid URL');
    }
  }

  if (!config.apiKey) {
    issues.push('AI_SERVICE_API_KEY is missing');
  } else if (config.apiKey === C.PLACEHOLDER_API_KEY) {
    issues.push('AI_SERVICE_API_KEY is still the placeholder value');
  }

  if (config.timeoutMs < 100 || config.timeoutMs > 1000) {
    issues.push('AI_DETECT_TIMEOUT_MS should be between 100 and 1000');
  }

  return {
    ok: issues.length === 0,
    skipped: false,
    enabled: config.enabled,
    issues,
    config: sanitizeConfig(config),
  };
}

function sanitizeConfig(config) {
  return {
    enabled: config.enabled,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    readyTimeoutMs: config.readyTimeoutMs,
    apiKeySet: Boolean(config.apiKey),
    apiKeyPlaceholder: config.apiKey === C.PLACEHOLDER_API_KEY,
    loadedAt: config.loadedAt,
  };
}

function assertAiEnvironmentOrThrow(options = {}) {
  const result = validateAiEnvironment({ ...options, strict: true });
  if (!result.ok) {
    throw new AiDuplicateError(
      `AI environment invalid: ${result.issues.join('; ')}`,
      'AI_ENV_INVALID',
      result
    );
  }
  return result;
}

module.exports = {
  loadAiConfig,
  validateAiEnvironment,
  sanitizeConfig,
  assertAiEnvironmentOrThrow,
};
