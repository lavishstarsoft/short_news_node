'use strict';

/** Phase-1 defaults — AI stays OFF unless env explicitly enables it. */
module.exports = {
  ENV_ENABLED: 'AI_DUPLICATE_ENABLED',
  ENV_SERVICE_URL: 'AI_SERVICE_URL',
  ENV_API_KEY: 'AI_SERVICE_API_KEY',
  ENV_TIMEOUT_MS: 'AI_DETECT_TIMEOUT_MS',
  ENV_READY_TIMEOUT_MS: 'AI_READY_TIMEOUT_MS',
  ENV_LOG: 'AI_DUPLICATE_LOG',

  DEFAULT_SERVICE_URL: 'http://127.0.0.1:8000',
  /** Detect budget — media cascade needs downloads; keep >= 8s in production. */
  DEFAULT_TIMEOUT_MS: 12000,
  /** Hard ceiling so misconfigured env cannot hang forever. */
  MAX_TIMEOUT_MS: 30000,
  DEFAULT_READY_TIMEOUT_MS: 2000,

  PLACEHOLDER_API_KEY: 'change-me-to-a-long-random-secret',
};
