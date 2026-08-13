'use strict';

/**
 * otpService.js — Phase-1 Registered-Email OTP backbone (State In-Charge agreement).
 *
 * PURELY ADDITIVE + FAIL-SAFE. Not wired to any route yet → existing login/auth
 * flows are untouched. Uses ONLY built-in `crypto` + the existing Redis client
 * (no new package). The OTP itself is NEVER stored in plain text and NEVER logged;
 * only a salted SHA-256 hash + TTL live in Redis.
 *
 * Identity rule: the caller must resolve the Admin record server-side FIRST and
 * pass its `adminId` + verified `email`. OTP is keyed by adminId, so a user cannot
 * redirect the OTP to a different address by changing the email field.
 *
 * Config (all optional; safe defaults; secrets only from env):
 *   AGREEMENT_OTP_TTL_SEC (600) · AGREEMENT_OTP_MAX_ATTEMPTS (5)
 *   AGREEMENT_OTP_RESEND_COOLDOWN_SEC (60)
 *   AGREEMENT_OTP_RATE_WINDOW_SEC (3600) · AGREEMENT_OTP_MAX_PER_EMAIL (5) · AGREEMENT_OTP_MAX_PER_IP (15)
 *   AGREEMENT_OTP_PEPPER (falls back to JWT secret) — hardens the 6-digit hash.
 */

const crypto = require('crypto');
const { redisClient, isRedisAvailable } = require('../../config/redis');

let getPepper = () => {
  if (process.env.AGREEMENT_OTP_PEPPER) return process.env.AGREEMENT_OTP_PEPPER;
  try { return require('../../config/secrets').getJwtSecret(); } catch (_) { return 'dev_pepper'; }
};

const NS = 'agr:otp:';
const num = (k, d) => { const v = parseInt(process.env[k], 10); return Number.isFinite(v) && v > 0 ? v : d; };
const CFG = {
  ttl: num('AGREEMENT_OTP_TTL_SEC', 600),
  maxAttempts: num('AGREEMENT_OTP_MAX_ATTEMPTS', 5),
  resendCooldown: num('AGREEMENT_OTP_RESEND_COOLDOWN_SEC', 60),
  rateWindow: num('AGREEMENT_OTP_RATE_WINDOW_SEC', 3600),
  maxPerEmail: num('AGREEMENT_OTP_MAX_PER_EMAIL', 5),
  maxPerIp: num('AGREEMENT_OTP_MAX_PER_IP', 15)
};

function gen6() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function hashOtp(otp, adminId) {
  return crypto.createHmac('sha256', getPepper()).update(`${adminId}:${otp}`).digest('hex');
}

async function bump(key, ttl) {
  if (!isRedisAvailable()) return 0;
  try { const n = await redisClient.incr(NS + key); if (n === 1) await redisClient.expire(NS + key, ttl); return n; }
  catch (_) { return 0; }
}

/**
 * Generate + store an OTP for a resolved State In-Charge. Enforces resend cooldown
 * and per-email / per-IP rate limits. Returns the plaintext OTP ONLY so the caller
 * can hand it straight to emailService — it must never be returned to the client or logged.
 *
 * @returns {Promise<{status:'sent'|'cooldown'|'rate_limited'|'unavailable', otp?:string, retryAfterSec?:number}>}
 */
async function requestOtp({ adminId, ip }) {
  if (!adminId) return { status: 'unavailable' };
  if (!isRedisAvailable()) return { status: 'unavailable' };
  const id = String(adminId);
  try {
    // resend cooldown
    if (await redisClient.exists(NS + `cool:${id}`)) {
      const ttl = await redisClient.ttl(NS + `cool:${id}`);
      return { status: 'cooldown', retryAfterSec: ttl > 0 ? ttl : CFG.resendCooldown };
    }
    // rate limits (email + ip)
    const perEmail = await bump(`rate:email:${id}`, CFG.rateWindow);
    const perIp = ip ? await bump(`rate:ip:${ip}`, CFG.rateWindow) : 0;
    if (perEmail > CFG.maxPerEmail || (ip && perIp > CFG.maxPerIp)) {
      return { status: 'rate_limited' };
    }
    const otp = gen6();
    await redisClient.set(NS + `code:${id}`, hashOtp(otp, id), { EX: CFG.ttl });
    await redisClient.set(NS + `att:${id}`, '0', { EX: CFG.ttl });
    await redisClient.set(NS + `cool:${id}`, '1', { EX: CFG.resendCooldown });
    return { status: 'sent', otp };
  } catch (_) { return { status: 'unavailable' }; }
}

/**
 * Verify an OTP for a resolved adminId. Increments attempts; on max attempts it
 * invalidates the code and raises a SecurityAlert. On success it consumes the code.
 * @returns {Promise<{ok:boolean, adminId?:string, reason?:string}>}
 */
async function verifyOtp({ adminId, otp, ip }) {
  if (!adminId || !otp) return { ok: false, reason: 'invalid' };
  if (!isRedisAvailable()) return { ok: false, reason: 'unavailable' };
  const id = String(adminId);
  try {
    const stored = await redisClient.get(NS + `code:${id}`);
    if (!stored) return { ok: false, reason: 'expired' };

    const attempts = await bump(`att:${id}`, CFG.ttl); // note: att key already exists with its own TTL
    if (attempts > CFG.maxAttempts) {
      await redisClient.del(NS + `code:${id}`);
      raiseAlert(ip, id, 'OTP max attempts exceeded (agreement)');
      return { ok: false, reason: 'too_many_attempts' };
    }

    const match = crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(hashOtp(String(otp), id)));
    if (!match) {
      if (attempts >= CFG.maxAttempts) raiseAlert(ip, id, 'OTP repeated wrong codes (agreement)');
      return { ok: false, reason: 'wrong' };
    }
    // success → consume
    await redisClient.del(NS + `code:${id}`);
    await redisClient.del(NS + `att:${id}`);
    return { ok: true, adminId: id };
  } catch (_) { return { ok: false, reason: 'unavailable' }; }
}

function raiseAlert(ip, adminId, message) {
  try {
    require('../security/alertEngine').record({
      type: 'suspicious_session', severity: 'MEDIUM',
      ip: ip || '', account: adminId, endpoint: '/state-agreement/verify-otp',
      message, details: { context: 'agreement_otp' }
    });
  } catch (_) { /* fail-open */ }
}

module.exports = { requestOtp, verifyOtp, CFG };
