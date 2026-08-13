'use strict';

/**
 * emailService.js — minimal SMTP email sender for agreement OTP (Phase-1).
 *
 * ADDITIVE + SAFE-TO-LOAD: `nodemailer` is required LAZILY (only when actually
 * sending), so this file loads fine even before the package is installed. Nothing
 * in the existing app uses it yet.
 *
 * ALL credentials come from environment variables only — never hard-coded:
 *   SMTP_HOST · SMTP_PORT · SMTP_SECURE(true/false) · SMTP_USER · SMTP_PASS
 *   MAIL_FROM (e.g. "Tehelka News <no-reply@yourdomain.com>")
 *
 * The OTP value is never logged.
 */

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_FROM);
}

let _transport = null;
function getTransport() {
  if (_transport) return _transport;
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (_) { throw new Error('nodemailer is not installed — run: npm install nodemailer'); }
  if (!isConfigured()) throw new Error('SMTP env vars not configured (SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM)');
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true=465(SSL), false=587(STARTTLS)
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // Never hang the app if the SMTP provider is slow/unreachable.
    connectionTimeout: parseInt(process.env.SMTP_CONN_TIMEOUT_MS, 10) || 10000,
    greetingTimeout: parseInt(process.env.SMTP_GREET_TIMEOUT_MS, 10) || 10000,
    socketTimeout: parseInt(process.env.SMTP_SOCKET_TIMEOUT_MS, 10) || 20000,
    // Keep TLS strong — do NOT disable verification just to pass a test.
    requireTLS: process.env.SMTP_SECURE !== 'true', // enforce STARTTLS on 587
    tls: { minVersion: 'TLSv1.2', servername: process.env.SMTP_HOST }
  });
  return _transport;
}

/** Verify SMTP connectivity (for a health check / setup test). Never sends mail. */
async function verifyConnection() {
  try { await getTransport().verify(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

/**
 * Send the agreement OTP to a server-resolved registered email.
 * @param {string} toEmail  registered email (from the Admin record, NOT user input)
 * @param {string} otp      6-digit code
 * @param {object} [opts]   { name }
 */
async function sendOtpEmail(toEmail, otp, opts = {}) {
  const name = opts.name || 'State In-Charge';
  const info = await getTransport().sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: 'Your State In-Charge Agreement verification code',
    text: `Dear ${name},\n\nYour one-time verification code is: ${otp}\n\nIt is valid for a few minutes. Do not share this code with anyone.\n\nIf you did not request this, you can ignore this email.\n\n— Tehelka News`,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
      <p>Dear ${name},</p>
      <p>Your one-time verification code is:</p>
      <p style="font-size:26px;font-weight:bold;letter-spacing:4px;color:#E31E24">${otp}</p>
      <p>It is valid for a few minutes. <b>Do not share this code with anyone.</b></p>
      <p style="color:#777">If you did not request this, you can ignore this email.</p>
      <p>— Tehelka News</p></div>`
  });
  return { ok: true, id: info && info.messageId };
}

module.exports = { isConfigured, verifyConnection, sendOtpEmail };
