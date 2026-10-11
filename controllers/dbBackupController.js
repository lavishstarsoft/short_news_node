// dbBackupController.js — Super-Admin "Database Backups" dashboard page.
// List / run-now / download (streamed) / delete (email-OTP protected).
// Reuses the same OTP + email infra as the agreement-data purge flow, and the
// same authorized delete email.

const requestIp = require('request-ip');
const otpService = require('../services/agreement/otpService');
const emailService = require('../services/agreement/emailService');
const backup = require('../services/dbBackupService');

const AUTHORIZED_DELETE_OTP_EMAIL = 'ashokca810@gmail.com';

function isSuperAdmin(req) { return req.admin && req.admin.role === 'superadmin'; }
function maskEmail(e) { const [u, d] = String(e || '').split('@'); return d ? ((u ? u[0] : '?') + '***@' + d) : '—'; }
function backupOtpId(req) { return 'backup-delete:' + String((req.admin && (req.admin.id || req.admin._id)) || ''); }

// GET /admin/db-backups
async function renderPage(req, res) {
  if (!isSuperAdmin(req)) return res.status(403).send('Super Admin only.');
  let backups = [];
  let loadError = null;
  try {
    backups = await backup.listBackups();
  } catch (e) {
    console.error('db-backups list error:', e);
    loadError = 'Could not load backups from storage.';
  }
  res.render('db-backups', {
    title: 'Database Backups',
    admin: req.admin,
    activePage: 'db-backups',
    backups,
    loadError,
    retention: backup.RETENTION,
    otpEmailMasked: maskEmail(AUTHORIZED_DELETE_OTP_EMAIL),
  });
}

// POST /admin/db-backups/run — trigger a backup NOW.
// Runs in a DETACHED child process (same script as the cron), so the heavy
// mongodump + multi-GB upload never loads the live app process and the HTTP
// request returns instantly (no proxy/browser timeout). Refresh in a few minutes.
async function runNow(req, res) {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  try {
    const { spawn } = require('child_process');
    const path = require('path');
    const script = path.join(__dirname, '..', 'tools', 'db-backup-cron.js');
    const child = spawn(process.execPath, [script], {
      cwd: path.join(__dirname, '..'),
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.on('error', (e) => console.error('db-backups spawn error:', e));
    child.unref();
    return res.json({ ok: true, started: true });
  } catch (e) {
    console.error('db-backups run error:', e);
    return res.status(500).json({ error: 'Could not start backup: ' + (e.message || 'unknown error') });
  }
}

// GET /admin/db-backups/download?key=...
async function download(req, res) {
  if (!isSuperAdmin(req)) return res.status(403).send('Super Admin only.');
  try {
    await backup.streamDownload(String(req.query.key || ''), res);
  } catch (e) {
    console.error('db-backups download error:', e);
    if (!res.headersSent) res.status(500).send('Download failed.');
  }
}

// POST /admin/db-backups/delete/send-otp — OTP to the authorized email.
async function sendDeleteOtp(req, res) {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const { isRedisAvailable } = require('../config/redis');
  if (!isRedisAvailable()) return res.status(503).json({ error: 'Verification service is temporarily unavailable. Try again shortly.' });
  if (!emailService.isConfigured()) return res.status(503).json({ error: 'Email service is not configured; cannot send the verification code.' });
  try {
    const ip = requestIp.getClientIp(req) || req.ip || '';
    const r = await otpService.requestOtp({ adminId: backupOtpId(req), ip });
    if (r.status === 'sent') {
      await emailService.sendOtpEmail(AUTHORIZED_DELETE_OTP_EMAIL, r.otp, {
        name: 'Super Admin',
        subject: 'Database Backup Deletion — verification code',
      }).catch(() => {});
      return res.json({ ok: true, sentTo: maskEmail(AUTHORIZED_DELETE_OTP_EMAIL) });
    }
    if (r.status === 'cooldown') return res.status(429).json({ error: 'Please wait before requesting another code.', retryAfterSec: r.retryAfterSec });
    if (r.status === 'rate_limited') return res.status(429).json({ error: 'Too many code requests. Please try later.' });
    return res.status(503).json({ error: 'Could not generate a verification code right now.' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to send the verification code.' });
  }
}

// POST /admin/db-backups/delete/confirm — verify OTP + delete the backup.
async function confirmDelete(req, res) {
  if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin only.' });
  const body = req.body || {};
  const key = String(body.key || '').trim();
  const otp = String(body.otp || '').trim();
  if (!key) return res.status(400).json({ error: 'Missing backup to delete.' });
  if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Enter the 6-digit verification code.' });

  const ip = requestIp.getClientIp(req) || req.ip || '';
  const v = await otpService.verifyOtp({ adminId: backupOtpId(req), otp, ip });
  if (!v.ok) {
    const msg = v.reason === 'expired' ? 'Verification code expired. Please request a new one.'
      : v.reason === 'too_many_attempts' ? 'Too many incorrect attempts. Request a new code.'
      : v.reason === 'unavailable' ? 'Verification service unavailable. Try again shortly.'
      : 'Invalid verification code.';
    return res.status(400).json({ error: msg });
  }
  try {
    await backup.deleteBackup(key);
    return res.json({ ok: true });
  } catch (e) {
    console.error('db-backups delete error:', e);
    return res.status(500).json({ error: 'Delete failed: ' + (e.message || 'unknown error') });
  }
}

module.exports = { renderPage, runNow, download, sendDeleteOtp, confirmDelete };
