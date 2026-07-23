'use strict';

const { toSafeErrorMessage } = require('./errors');

/**
 * Health / readiness utilities for ai-service.
 * When AI is disabled: no network I/O (production-safe).
 * axios is required lazily only when a client is constructed.
 */
function createHealthClient(deps = {}) {
  const http = deps.http || require('axios');
  const getConfig = deps.getConfig;
  const log = deps.log || { debug() {}, warn() {} };

  if (typeof getConfig !== 'function') {
    throw new Error('createHealthClient requires getConfig()');
  }

  async function pingHealth(options = {}) {
    const cfg = getConfig();
    const force = options.force === true;
    if (!cfg.enabled && !force) {
      return { ok: false, skipped: true, reason: 'disabled' };
    }

    try {
      const response = await http.get(`${cfg.baseUrl}/healthz`, {
        timeout: cfg.readyTimeoutMs || cfg.timeoutMs,
        validateStatus: () => true,
      });
      const ok = response.status === 200;
      log.debug('AI healthz', { ok, status: response.status });
      return { ok, status: response.status, data: response.data };
    } catch (err) {
      return { ok: false, error: toSafeErrorMessage(err) };
    }
  }

  async function pingReady(options = {}) {
    const cfg = getConfig();
    const force = options.force === true;
    if (!cfg.enabled && !force) {
      return { ok: false, skipped: true, reason: 'disabled' };
    }

    try {
      const response = await http.get(`${cfg.baseUrl}/readyz`, {
        timeout: cfg.readyTimeoutMs || cfg.timeoutMs,
        validateStatus: () => true,
      });
      const ok = response.status === 200;
      log.debug('AI readyz', { ok, status: response.status });
      return { ok, status: response.status, data: response.data };
    } catch (err) {
      return { ok: false, error: toSafeErrorMessage(err) };
    }
  }

  return {
    pingHealth,
    pingReady,
  };
}

module.exports = {
  createHealthClient,
};
