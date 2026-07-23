'use strict';

/**
 * Central AI Duplicate infrastructure module (Phase-1).
 *
 * - NOT wired into newsController / create / approve flows
 * - AI defaults to DISABLED
 * - Existing duplicateCheckService remains the production detector
 * - require() has no network I/O and does not construct the singleton
 */

const {
  loadAiConfig,
  validateAiEnvironment,
  sanitizeConfig,
  assertAiEnvironmentOrThrow,
} = require('./config');
const { loadFeatureFlag, isAiDuplicateEnabled } = require('./featureFlag');
const { createAiLogger } = require('./logger');
const { createHttpClient } = require('./client');
const { createHealthClient } = require('./health');
const { AiDuplicateError } = require('./errors');
const constants = require('./constants');

/**
 * Factory for dependency injection / tests.
 * @param {object} [deps]
 * @param {object} [deps.env]
 * @param {object} [deps.http] axios-like
 * @param {object} [deps.logger] pino-like
 */
function createAiDuplicateService(deps = {}) {
  const env = deps.env || process.env;
  let cachedConfig = null;

  function getConfig() {
    if (!cachedConfig) {
      cachedConfig = loadAiConfig(env);
    }
    return cachedConfig;
  }

  function reloadConfig() {
    cachedConfig = loadAiConfig(env);
    return cachedConfig;
  }

  const log = createAiLogger({
    logger: deps.logger,
    isEnabled: () => getConfig().enabled,
  });

  // Lazy default http — only resolved when service instance is created
  const http = deps.http || require('axios');
  const httpClient = createHttpClient({ http, getConfig, log });
  const healthClient = createHealthClient({ http, getConfig, log });

  let initialized = false;

  /**
   * Safe init — no network calls when AI is disabled.
   */
  function init() {
    if (initialized) {
      return getStatus();
    }

    reloadConfig();
    const validation = validateAiEnvironment({ env, strict: false });
    initialized = true;

    if (!getConfig().enabled) {
      log.debug('AI duplicate infra initialized (disabled)');
      return getStatus();
    }

    log.info('AI duplicate infra initialized (enabled)', {
      validationOk: validation.ok,
      issues: validation.issues,
      config: validation.config,
    });

    if (!validation.ok) {
      log.warn('AI enabled but environment invalid — callers must fallback', {
        issues: validation.issues,
      });
    }

    return getStatus();
  }

  function getStatus() {
    const config = getConfig();
    return {
      initialized,
      enabled: config.enabled,
      phase: 1,
      wiredToNewsFlows: false,
      config: sanitizeConfig(config),
      validation: validateAiEnvironment({ env, strict: false }),
    };
  }

  async function detectDuplicate(payload) {
    init();
    return httpClient.detectDuplicate(payload);
  }

  async function detectWithFallback(payload, fallbackFn) {
    init();

    if (typeof fallbackFn !== 'function') {
      throw new AiDuplicateError(
        'detectWithFallback requires a fallbackFn',
        'AI_INVALID_FALLBACK'
      );
    }

    if (!isAiDuplicateEnabled(env)) {
      const result = await fallbackFn();
      return { result, source: 'fallback' };
    }

    try {
      assertAiEnvironmentOrThrow({ env });
    } catch (err) {
      log.warn('AI env invalid — using fallback', {
        issues: err.details && err.details.issues,
      });
      const result = await fallbackFn();
      return {
        result,
        source: 'fallback',
        ai: { ok: false, source: 'error', error: 'AI_ENV_INVALID', issues: err.details && err.details.issues },
      };
    }

    const ai = await httpClient.detectDuplicate(payload);
    if (ai.ok) {
      return { result: ai.data, source: 'ai', ai };
    }

    log.debug('AI detect not usable — using fallback', { source: ai.source });
    const result = await fallbackFn();
    return { result, source: 'fallback', ai };
  }

  return {
    init,
    getStatus,
    getConfig,
    reloadConfig,
    loadFeatureFlag: () => loadFeatureFlag(env),
    isAiDuplicateEnabled: () => isAiDuplicateEnabled(env),
    validateAiEnvironment: (opts) => validateAiEnvironment({ env, ...opts }),
    detectDuplicate,
    detectWithFallback,
    pingHealth: (options) => {
      init();
      return healthClient.pingHealth(options);
    },
    pingReady: (options) => {
      init();
      return healthClient.pingReady(options);
    },
    constants,
    AiDuplicateError,
  };
}

/** Default singleton — created only when getDefaultService() / stateful APIs run. */
let defaultService = null;

function getDefaultService() {
  if (!defaultService) {
    defaultService = createAiDuplicateService();
  }
  return defaultService;
}

function initAiDuplicateInfrastructure() {
  return getDefaultService().init();
}

function resetAiDuplicateServiceForTests() {
  defaultService = null;
}

function hasDefaultServiceForTests() {
  return defaultService !== null;
}

module.exports = {
  createAiDuplicateService,
  getDefaultService,
  initAiDuplicateInfrastructure,
  resetAiDuplicateServiceForTests,
  hasDefaultServiceForTests,

  // Pure helpers — do NOT construct the singleton
  loadFeatureFlag,
  isAiDuplicateEnabled,
  loadAiConfig,
  validateAiEnvironment,
  sanitizeConfig,
  assertAiEnvironmentOrThrow,
  AiDuplicateError,
  constants,

  // Stateful APIs — construct singleton lazily on first call
  init: () => getDefaultService().init(),
  getStatus: () => getDefaultService().getStatus(),
  getConfig: () => getDefaultService().getConfig(),
  reloadConfig: () => getDefaultService().reloadConfig(),
  detectDuplicate: (payload) => getDefaultService().detectDuplicate(payload),
  detectWithFallback: (payload, fallbackFn) =>
    getDefaultService().detectWithFallback(payload, fallbackFn),
  pingHealth: (options) => getDefaultService().pingHealth(options),
  pingReady: (options) => getDefaultService().pingReady(options),
};
