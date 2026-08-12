'use strict';

/**
 * csrfGuard — origin/same-site CSRF protection for COOKIE-authenticated browser
 * requests only. FAIL-OPEN, detect-only by default.
 *
 * Why origin-based (not token cookies): the dashboard uses many existing AJAX
 * calls; requiring a CSRF token everywhere would risk breaking them. A forged
 * cross-site request cannot control the browser's Origin/Referer, so validating
 * that Origin matches our own host is a reliable, ZERO-client-change CSRF signal.
 *
 * Scope (only these are checked):
 *   - state-changing methods (POST/PUT/PATCH/DELETE)
 *   - request carries the session cookie ('token')  → i.e. a browser dashboard call
 * Skipped (never affected):
 *   - safe methods (GET/HEAD/OPTIONS)
 *   - mobile / API / server-to-server (no cookie, Authorization header instead)
 *   - requests with no Origin AND no Referer (native apps / curl / same-process)
 *
 * Enforcement is OFF unless SECURITY_CSRF_ENFORCE=true; until then it only records
 * a `csrf_violation` alert. Even when enforcing, mobile/API is untouched.
 */

const engine = require('../services/security/alertEngine');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function envAllowlist() {
  return new Set([
    'https://news.lavishstar.in', 'https://report.cbnyellowsingam.in',
    'https://www.news.cbnyellowsingam.in', 'https://news.cbnyellowsingam.in',
    'https://www.news.tehelkanews.in', 'https://news.tehelkanews.in',
    'https://report.tehelkanews.in',
    ...((process.env.CORS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean))
  ]);
}
const isLocalhost = (o) => /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.\d+\.\d+)(:\d+)?$/.test(o || '');

function hostOf(url) { try { return new URL(url).host; } catch (_) { return ''; } }

module.exports = function csrfGuard() {
  const allow = envAllowlist();
  return function (req, res, next) {
    try {
      if (SAFE.has(req.method)) return next();
      // Only browser, cookie-authenticated sessions are in scope.
      const hasSessionCookie = !!(req.cookies && req.cookies.token);
      if (!hasSessionCookie) return next(); // mobile/API/server-to-server → untouched

      const origin = req.headers.origin || '';
      const referer = req.headers.referer || '';
      // No Origin AND no Referer on a cookie session is unusual but not provably CSRF
      // (some privacy setups strip both); do not act — fail-open.
      if (!origin && !referer) return next();

      const src = origin || referer;
      const srcHost = hostOf(src);
      const selfHost = req.headers.host || '';

      const ok = (srcHost && srcHost === selfHost) || allow.has(origin) || isLocalhost(origin) ||
        [...allow].some((a) => hostOf(a) === srcHost);

      if (!ok) {
        try {
          const requestIp = require('request-ip');
          engine.record({
            type: 'csrf_violation', severity: 'HIGH',
            ip: requestIp.getClientIp(req) || req.ip, method: req.method, endpoint: req.path,
            account: (req.admin && req.admin.username) || '',
            userAgent: req.headers['user-agent'],
            message: `Cross-site state-changing request from foreign origin (${srcHost || 'unknown'})`,
            details: { origin: origin || null, referer: referer || null, host: selfHost }
          });
        } catch (_) { /* alerting must not affect the request */ }

        if (process.env.SECURITY_CSRF_ENFORCE === 'true') {
          return res.status(403).json({ error: 'Request blocked: invalid origin (possible CSRF).' });
        }
      }
    } catch (_) { /* fail-open */ }
    next();
  };
};
