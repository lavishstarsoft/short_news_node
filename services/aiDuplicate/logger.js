'use strict';

/**
 * AI duplicate logging — silent when AI is disabled (production-safe).
 * Never logs API keys.
 * Child logger is per factory instance (no module-level singleton leak).
 */

function getBaseLogger() {
  try {
    return require('../../config/logger').logger;
  } catch (_) {
    return null;
  }
}

function envLogForced() {
  const v = process.env.AI_DUPLICATE_LOG;
  return v === 'true' || v === '1' || v === 'yes';
}

function createAiLogger(deps = {}) {
  const base = deps.logger || null;
  const isEnabledFn = deps.isEnabled || (() => false);
  let childLogger = null;

  function shouldLog() {
    return envLogForced() || isEnabledFn() === true;
  }

  function resolveBase() {
    if (base) return base;
    // Lazy hidden import — only when logging is actually needed
    return getBaseLogger();
  }

  function bind() {
    if (childLogger) return childLogger;
    const resolved = resolveBase();
    if (resolved && typeof resolved.child === 'function') {
      childLogger = resolved.child({ module: 'aiDuplicate' });
      return childLogger;
    }
    return null;
  }

  return {
    debug(msg, obj) {
      if (!shouldLog()) return;
      const log = bind();
      if (log) log.debug(obj || {}, msg);
      else {
        // eslint-disable-next-line no-console
        console.debug(`[aiDuplicate] ${msg}`, obj || '');
      }
    },
    info(msg, obj) {
      if (!shouldLog()) return;
      const log = bind();
      if (log) log.info(obj || {}, msg);
      else {
        // eslint-disable-next-line no-console
        console.info(`[aiDuplicate] ${msg}`, obj || '');
      }
    },
    warn(msg, obj) {
      if (!shouldLog()) return;
      const log = bind();
      if (log) log.warn(obj || {}, msg);
      else {
        // eslint-disable-next-line no-console
        console.warn(`[aiDuplicate] ${msg}`, obj || '');
      }
    },
    error(msg, obj) {
      if (!shouldLog()) return;
      const log = bind();
      if (log) log.error(obj || {}, msg);
      else {
        // eslint-disable-next-line no-console
        console.error(`[aiDuplicate] ${msg}`, obj || '');
      }
    },
  };
}

module.exports = {
  createAiLogger,
};
