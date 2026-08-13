'use strict';

/**
 * smtp-otp-test.js — ISOLATED SMTP test (Phase-1 verification only).
 *
 * Sends ONE test 6-digit OTP email via the existing services/agreement/emailService
 * (from support@tehelkanews.in). It touches NOTHING else — no DB, no Redis, no
 * routes, no login/JWT/auth. Safe, standalone, run-on-demand.
 *
 * Requires (in .env — password NEVER in code / output):
 *   SMTP_HOST=smtpout.secureserver.net  SMTP_PORT=465  SMTP_SECURE=true
 *   SMTP_USER=support@tehelkanews.in    SMTP_PASS=***   MAIL_FROM=Tehelka News <support@tehelkanews.in>
 * And nodemailer must be installed (npm install nodemailer).
 *
 * Usage:
 *   node scripts/smtp-otp-test.js you@example.com
 *   # or set TEST_OTP_EMAIL in .env and run: node scripts/smtp-otp-test.js
 */

require('dotenv').config();
const crypto = require('crypto');
const email = require('../services/agreement/emailService');

const to = process.argv[2] || process.env.TEST_OTP_EMAIL;

(async () => {
  console.log('--- SMTP OTP test (isolated) ---');
  // Show config presence WITHOUT revealing any secret value.
  console.log('SMTP configured:', email.isConfigured());
  console.log('Host:', process.env.SMTP_HOST || '(unset)',
    '| Port:', process.env.SMTP_PORT || '(unset)',
    '| Secure:', process.env.SMTP_SECURE || '(unset)',
    '| User:', process.env.SMTP_USER || '(unset)',
    '| From:', process.env.MAIL_FROM || '(unset)',
    '| Password set:', process.env.SMTP_PASS ? 'yes (hidden)' : 'NO');

  if (!to) {
    console.error('\n❌ No recipient. Pass one: node scripts/smtp-otp-test.js you@example.com');
    process.exit(1);
  }

  // 1) Verify SMTP connection first (does NOT send mail).
  console.log('\n[1/2] Verifying SMTP connection...');
  const conn = await email.verifyConnection();
  console.log('    verifyConnection:', JSON.stringify(conn));
  if (!conn.ok) {
    console.error('❌ SMTP connect failed. Check host/port/secure/credentials in .env. If 465 fails, try SMTP_PORT=587 + SMTP_SECURE=false.');
    process.exit(1);
  }

  // 2) Send a single test OTP.
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  console.log(`\n[2/2] Sending test OTP to ${to} ...`);
  try {
    const res = await email.sendOtpEmail(to, otp, { name: 'Test User' });
    console.log('    ✅ Sent. SMTP messageId:', res.id || '(none)');
    console.log('    (OTP was emailed; not printed here on purpose.)');
    console.log('\n✅ SMTP TEST PASSED — check the inbox (and Spam) of', to);
  } catch (e) {
    console.error('    ❌ Send failed:', e.message);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
