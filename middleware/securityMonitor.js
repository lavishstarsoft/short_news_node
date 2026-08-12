'use strict';

/**
 * securityMonitor — global, lightweight, FAIL-OPEN security middleware.
 *
 *  1. (optional, only when SECURITY_ENFORCE=true) rejects requests from an IP that
 *     the engine has temporarily blocked. Blocks are Redis TTL keys → auto-rollback.
 *  2. observes the final response status (on 'finish') and feeds 4xx/5xx to the
 *     engine for enumeration / abuse / error-spike detection.
 *
 * It never mutates the request/response body and adds ~microseconds; any fault is
 * swallowed so it can never break the app. Static assets are skipped.
 */

const requestIp = require('request-ip');
const engine = require('../services/security/alertEngine');

const SKIP = /^\/(images|css|js|fonts|lottie|sounds|favicon|health|socket\.io|uploads)\b/i;

function clientIp(req) {
  try { return requestIp.getClientIp(req) || req.ip || ''; } catch (_) { return req.ip || ''; }
}

module.exports = function securityMonitor() {
  return async function (req, res, next) {
    if (SKIP.test(req.path)) return next();
    const ip = clientIp(req);

    // 1. Enforcement (default OFF). Fail-open: any error → allow.
    try {
      if (engine.CFG.enforce && ip && await engine.isBlocked(ip)) {
        engine.record({ type: 'blocked_request', ip, method: req.method, endpoint: req.path,
          userAgent: req.headers['user-agent'] });
        return res.status(429).json({ error: 'Temporarily blocked due to suspicious activity. Try again later.' });
      }
    } catch (_) { /* fail-open */ }

    // 2. Observe response status (non-blocking).
    res.on('finish', () => {
      try {
        const code = res.statusCode || 0;
        if (code >= 400) {
          engine.record({
            type: 'http_error', ip, method: req.method, endpoint: req.path,
            statusCode: code, userAgent: req.headers['user-agent'],
            account: req.admin?.username || ''
          });
        }
      } catch (_) { /* fail-open */ }
    });

    next();
  };
};
