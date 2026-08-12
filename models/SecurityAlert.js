const mongoose = require('mongoose');

/**
 * SecurityAlert — append-only record of security-relevant events/alerts raised by
 * the central Security Alert Engine (services/security/alertEngine.js).
 *
 * Design notes:
 *  - APPEND-ONLY: rows are created once; the ONLY mutation allowed is marking an
 *    alert resolved (resolvedAt/resolvedBy). No edit/delete of the event facts.
 *  - Never stores secrets (passwords, JWTs, API keys) — only metadata.
 *  - TTL retention keeps the collection bounded on a busy site (default 30 days;
 *    tune via SECURITY_ALERT_RETENTION_DAYS). Resolved/audit copies that must be
 *    kept longer should be exported before expiry.
 */
const SEVERITIES = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const securityAlertSchema = new mongoose.Schema(
  {
    // Stable machine key for the detector, e.g. 'login_bruteforce', 'endpoint_enumeration'.
    type: { type: String, required: true, index: true },
    severity: { type: String, enum: SEVERITIES, default: 'INFO', index: true },

    // Corroborating metadata (never identity by itself).
    ip: { type: String, default: '', index: true },
    method: { type: String, default: '' },
    endpoint: { type: String, default: '', index: true },
    statusCode: { type: Number, default: 0 },
    userAgent: { type: String, default: '' },

    // Affected/acting account, if known (username or admin id — never password).
    account: { type: String, default: '' },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },

    // Human summary + structured, secret-free details for the dashboard.
    message: { type: String, default: '' },
    details: { type: mongoose.Schema.Types.Mixed, default: null },

    // How many times this exact signature fired within the dedup window
    // (the engine collapses repeats into count++ instead of new rows).
    count: { type: Number, default: 1 },

    // Response action taken automatically (if any), for audit + rollback.
    actionTaken: { type: String, default: 'none' }, // none | ip_blocked | throttled | session_invalidated
    actionMeta: { type: mongoose.Schema.Types.Mixed, default: null },

    // Which app instance recorded it (PM2 cluster).
    workerId: { type: String, default: '' },

    // Resolution (the only permitted mutation).
    resolved: { type: Boolean, default: false, index: true },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: '' },
    lastSeenAt: { type: Date, default: Date.now }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Dashboard queries: recent unresolved by severity; top IPs / endpoints.
securityAlertSchema.index({ createdAt: -1 });
securityAlertSchema.index({ resolved: 1, severity: 1, createdAt: -1 });

// TTL retention (bounded storage). Default 30 days.
const RETENTION_DAYS = Math.max(1, parseInt(process.env.SECURITY_ALERT_RETENTION_DAYS, 10) || 30);
securityAlertSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });

securityAlertSchema.statics.SEVERITIES = SEVERITIES;

module.exports = mongoose.model('SecurityAlert', securityAlertSchema);
