'use strict';

/**
 * securityReportRoutes — public endpoint that receives browser CSP violation
 * reports and funnels them into the existing Security Alert Engine as
 * `csp_violation` events (deduped, severity LOW). No auth (browsers post these
 * automatically); fail-open; body size capped. No secrets are ever logged.
 */

const express = require('express');
const router = express.Router();
const requestIp = require('request-ip');
const engine = require('../services/security/alertEngine');

// Browsers send CSP reports as application/csp-report or application/reports+json.
const cspBody = express.json({
  type: ['application/csp-report', 'application/reports+json', 'application/json'],
  limit: '50kb'
});

router.post('/api/security/csp-report', cspBody, (req, res) => {
  try {
    const body = req.body || {};
    // CSP Level 2: { 'csp-report': {...} }; Reporting API: [{ body: {...} }, ...]
    const r = body['csp-report'] || (Array.isArray(body) ? (body[0] && body[0].body) : body) || {};
    const directive = r['violated-directive'] || r.effectiveDirective || r.violatedDirective || 'unknown';
    const blocked = r['blocked-uri'] || r.blockedURL || r.blockedUri || '';
    const docUri = r['document-uri'] || r.documentURL || '';
    engine.record({
      type: 'csp_violation', severity: 'LOW',
      ip: requestIp.getClientIp(req) || req.ip,
      endpoint: (docUri || '').slice(0, 200),
      userAgent: req.headers['user-agent'],
      message: `CSP: ${directive} blocked ${blocked || 'inline/eval'}`.slice(0, 300),
      details: { directive, blocked: String(blocked).slice(0, 300) }
    });
  } catch (_) { /* fail-open */ }
  res.status(204).end();
});

module.exports = router;
