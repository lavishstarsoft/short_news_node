'use strict';

/**
 * alertEngine.js — central Security Alert Engine.
 *
 * Ingests security-relevant events from lightweight hooks (failed logins, 4xx/5xx
 * responses, enumeration, etc.), maintains sliding-window counters in Redis
 * (PM2-cluster-safe + restart-safe), classifies severity, DEDUPLICATES repeats,
 * persists to the append-only SecurityAlert collection, and — only when explicitly
 * enabled — applies a conservative, auto-expiring response (temporary IP throttle).
 *
 * HARD RULES:
 *  - FAIL-OPEN: every path is wrapped so a fault here NEVER breaks a request.
 *  - No secrets are ever stored/logged (no passwords/JWTs/keys).
 *  - Response actions default to DETECT-ONLY; enable via env; all blocks are
 *    TTL-based so they self-rollback (no permanent lockout without admin action).
 *  - Behaviour-based only — never blocks by country/region.
 */

const crypto = require('crypto');
const { redisClient, isRedisAvailable } = require('../../config/redis');

let SecurityAlert = null;
function model() {
  if (!SecurityAlert) { try { SecurityAlert = require('../../models/SecurityAlert'); } catch (_) { SecurityAlert = null; } }
  return SecurityAlert;
}

const WORKER_ID = `${process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? ''}:${process.pid}`;
const NS = 'sec:'; // redis namespace

// ---- configurable thresholds (safe defaults; override via env) ---------------
const CFG = {
  enforce: process.env.SECURITY_ENFORCE === 'true',            // false = detect-only (recommended default)
  // failed logins from one IP within the window
  bruteIpWindowSec: num('SECURITY_BRUTE_WINDOW_SEC', 900),
  bruteIpThreshold: num('SECURITY_BRUTE_IP_MAX', 15),
  // failed logins against one account (credential-stuffing signal)
  bruteAcctThreshold: num('SECURITY_BRUTE_ACCT_MAX', 8),
  // distinct 404/401/403 paths from one IP (endpoint scanning/enumeration)
  enumWindowSec: num('SECURITY_ENUM_WINDOW_SEC', 300),
  enumThreshold: num('SECURITY_ENUM_MAX', 25),
  // repeated 401/403 on sensitive endpoints from one IP (IDOR / priv-esc probing)
  authzWindowSec: num('SECURITY_AUTHZ_WINDOW_SEC', 300),
  authzThreshold: num('SECURITY_AUTHZ_MAX', 10),
  // 4xx/5xx volume from one IP (abuse / abnormal traffic)
  errWindowSec: num('SECURITY_ERR_WINDOW_SEC', 120),
  err4xxThreshold: num('SECURITY_ERR4XX_MAX', 60),
  err5xxThreshold: num('SECURITY_ERR5XX_MAX', 25),
  // how long an auto temp-block lasts (auto-rollback)
  blockTtlSec: num('SECURITY_BLOCK_TTL_SEC', 900),
  // collapse identical alerts within this window into count++
  dedupWindowSec: num('SECURITY_DEDUP_WINDOW_SEC', 300)
};
function num(k, d) { const v = parseInt(process.env[k], 10); return Number.isFinite(v) && v > 0 ? v : d; }

const SEV = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/** Increment a sliding counter (fixed window via key TTL). Returns count or 0. */
async function bump(key, ttlSec) {
  if (!isRedisAvailable()) return 0;
  try {
    const n = await redisClient.incr(NS + key);
    if (n === 1) await redisClient.expire(NS + key, ttlSec);
    return n;
  } catch (_) { return 0; }
}

/** Track distinct members in a window (e.g. distinct enumerated paths). */
async function trackDistinct(key, member, ttlSec) {
  if (!isRedisAvailable()) return 0;
  try {
    await redisClient.sAdd(NS + key, member);
    await redisClient.expire(NS + key, ttlSec);
    return await redisClient.sCard(NS + key);
  } catch (_) { return 0; }
}

/** Is this IP currently temp-blocked? (used by middleware; fail-open = not blocked) */
async function isBlocked(ip) {
  if (!ip || !isRedisAvailable()) return false;
  try { return (await redisClient.exists(NS + 'block:' + ip)) === 1; } catch (_) { return false; }
}

/** Temp-block an IP for ttl seconds (auto-expires = safe rollback). */
async function blockIp(ip, ttlSec, reason) {
  if (!ip || !isRedisAvailable()) return false;
  try { await redisClient.set(NS + 'block:' + ip, reason || 'auto', { EX: ttlSec || CFG.blockTtlSec }); return true; }
  catch (_) { return false; }
}

/** Manual unblock (admin rollback). */
async function unblockIp(ip) {
  if (!ip || !isRedisAvailable()) return false;
  try { await redisClient.del(NS + 'block:' + ip); return true; } catch (_) { return false; }
}

/** Persist an alert, deduplicating identical signatures within the dedup window. */
async function persist({ type, severity, ip, method, endpoint, statusCode, userAgent, account, accountId, message, details, actionTaken, actionMeta }) {
  const M = model();
  if (!M) return;
  const sig = crypto.createHash('sha1')
    .update([type, ip || '', account || '', endpoint || ''].join('|')).digest('hex');
  const dedupKey = NS + 'dedup:' + sig;
  try {
    // Try to collapse into an existing recent alert row id stored in Redis.
    let existingId = null;
    if (isRedisAvailable()) { try { existingId = await redisClient.get(dedupKey); } catch (_) {} }
    if (existingId) {
      await M.updateOne({ _id: existingId }, { $inc: { count: 1 }, $set: { lastSeenAt: new Date(), severity } });
      return;
    }
    const doc = await M.create({
      type, severity, ip: ip || '', method: method || '', endpoint: (endpoint || '').slice(0, 300),
      statusCode: statusCode || 0, userAgent: (userAgent || '').slice(0, 300),
      account: (account || '').slice(0, 200), accountId: accountId || null,
      message: (message || '').slice(0, 500), details: details || null,
      actionTaken: actionTaken || 'none', actionMeta: actionMeta || null, workerId: WORKER_ID,
      lastSeenAt: new Date()
    });
    if (isRedisAvailable()) { try { await redisClient.set(dedupKey, String(doc._id), { EX: CFG.dedupWindowSec }); } catch (_) {} }
  } catch (_) { /* fail-open */ }
}

/**
 * Main ingest. Non-blocking, fail-open. Returns quickly; never throws.
 * @param {object} ev { type, ip, method, endpoint, statusCode, userAgent, account, accountId, message, details }
 */
async function record(ev) {
  try {
    if (!ev || !ev.type) return;
    const base = {
      ip: ev.ip || '', method: ev.method || '', endpoint: ev.endpoint || '',
      statusCode: ev.statusCode || 0, userAgent: ev.userAgent || '', account: ev.account || '',
      accountId: ev.accountId || null, details: ev.details || null
    };
    let severity = 'INFO', message = ev.message || ev.type, actionTaken = 'none', actionMeta = null;
    let shouldPersist = false;

    switch (ev.type) {
      case 'login_failed': {
        shouldPersist = false; // only the derived brute-force alert is persisted
        const ipCount = ev.ip ? await bump(`brute:ip:${ev.ip}`, CFG.bruteIpWindowSec) : 0;
        const acctCount = ev.account ? await bump(`brute:acct:${String(ev.account).toLowerCase()}`, CFG.bruteIpWindowSec) : 0;
        if (ipCount >= CFG.bruteIpThreshold || acctCount >= CFG.bruteAcctThreshold) {
          severity = ipCount >= CFG.bruteIpThreshold * 2 ? 'CRITICAL' : 'HIGH';
          message = `Repeated failed logins (ip=${ipCount}, account=${acctCount})`;
          shouldPersist = true;
          if (CFG.enforce && ev.ip && SEV[severity] >= SEV.HIGH) {
            if (await blockIp(ev.ip, CFG.blockTtlSec, 'bruteforce')) { actionTaken = 'ip_blocked'; actionMeta = { ttlSec: CFG.blockTtlSec }; }
          }
          return persist({ type: 'login_bruteforce', severity, ...base, message, actionTaken, actionMeta });
        }
        return;
      }
      case 'http_error': {
        // fed by the monitor middleware for 4xx/5xx responses
        const code = ev.statusCode || 0;
        if (!ev.ip || code < 400) return;
        // enumeration: many distinct not-found/forbidden paths
        if ([401, 403, 404].includes(code)) {
          const distinct = await trackDistinct(`enum:${ev.ip}`, ev.endpoint || '?', CFG.enumWindowSec);
          if (distinct >= CFG.enumThreshold) {
            severity = distinct >= CFG.enumThreshold * 2 ? 'HIGH' : 'MEDIUM';
            message = `Endpoint scanning/enumeration (${distinct} distinct paths)`;
            if (CFG.enforce && SEV[severity] >= SEV.HIGH && await blockIp(ev.ip, CFG.blockTtlSec, 'enumeration')) { actionTaken = 'ip_blocked'; }
            return persist({ type: 'endpoint_enumeration', severity, ...base, message, actionTaken });
          }
        }
        // authorization probing: repeated 401/403 on sensitive resource endpoints
        // (IDOR/BOLA / privilege-escalation attempts). Threshold-based to avoid
        // false positives from a single legitimate permission denial.
        if ([401, 403].includes(code) && /^\/(admin|editors|api|news|register-editor|view-engine)\b/.test(ev.endpoint || '')) {
          const az = await bump(`authz:${ev.ip}`, CFG.authzWindowSec);
          if (az >= CFG.authzThreshold) {
            severity = az >= CFG.authzThreshold * 2 ? 'HIGH' : 'MEDIUM';
            message = `Repeated authorization failures (${az} x ${code}) — possible IDOR/privilege-escalation probing`;
            return persist({ type: 'authorization_violation', severity, ...base, message });
          }
        }
        // volume abuse
        const bucket = code >= 500 ? 'err5xx' : 'err4xx';
        const cnt = await bump(`${bucket}:${ev.ip}`, CFG.errWindowSec);
        const thr = code >= 500 ? CFG.err5xxThreshold : CFG.err4xxThreshold;
        if (cnt >= thr) {
          severity = code >= 500 ? 'HIGH' : 'MEDIUM';
          message = `Abnormal ${bucket} volume from IP (${cnt} in ${CFG.errWindowSec}s)`;
          return persist({ type: code >= 500 ? 'error_spike_5xx' : 'abuse_4xx', severity, ...base, message });
        }
        return;
      }
      // Directly-raised, always-persisted signals (severity provided by caller or defaulted).
      case 'privilege_escalation':
        severity = 'HIGH'; message = ev.message || 'Privilege escalation attempt'; shouldPersist = true; break;
      case 'suspicious_upload':
        severity = ev.severity || 'MEDIUM'; message = ev.message || 'Suspicious upload rejected'; shouldPersist = true; break;
      case 'suspicious_session':
        severity = ev.severity || 'MEDIUM'; message = ev.message || 'Suspicious session/token activity'; shouldPersist = true; break;
      case 'blocked_request':
        severity = 'LOW'; message = ev.message || 'Blocked (temp IP block active)'; shouldPersist = true; break;
      case 'authorization_violation':
        severity = ev.severity || 'HIGH'; message = ev.message || 'Authorization violation (IDOR/BOLA)'; shouldPersist = true; break;
      case 'csrf_violation':
        severity = ev.severity || 'HIGH'; message = ev.message || 'Cross-site request (bad Origin) on state-changing request'; shouldPersist = true; break;
      case 'csp_violation':
        severity = ev.severity || 'LOW'; message = ev.message || 'Content-Security-Policy violation reported'; shouldPersist = true; break;
      default:
        severity = ev.severity || 'INFO'; message = ev.message || ev.type; shouldPersist = ev.persist === true;
    }

    if (shouldPersist) return persist({ type: ev.type, severity, ...base, message, actionTaken, actionMeta });
  } catch (_) { /* fail-open: never throw */ }
}

module.exports = { record, isBlocked, blockIp, unblockIp, CFG };
