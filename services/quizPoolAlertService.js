'use strict';

/**
 * Quiz pool-health alerting for the LIFETIME no-repeat model.
 *
 * Because every account permanently consumes questions, a language's fresh pool can
 * quietly run dry. When the unseen-question count for the current player drops to the
 * threshold, we (a) email support and (b) raise an admin-panel Notification so more
 * questions get uploaded before players hit "no question today".
 *
 * Designed to be invoked fire-and-forget from the hot assign path:
 *   • never throws (all wrapped) → can never affect gameplay,
 *   • throttled twice — the COUNT runs at most once/language/CHECK window, and the
 *     ALERT (email + notification) at most once/language/ALERT window — so it neither
 *     hammers the DB nor spams support.
 *
 * Config (env, all optional): QUIZ_POOL_ALERT_THRESHOLD (default 10),
 *   QUIZ_POOL_ALERT_COOLDOWN_HOURS (default 6), QUIZ_ALERT_EMAIL | SUPPORT_EMAIL.
 */

const QuizQuestion = require('../models/QuizQuestion');
const Notification = require('../models/Notification');
const email = require('./agreement/emailService');

const THRESHOLD = parseInt(process.env.QUIZ_POOL_ALERT_THRESHOLD, 10) || 10;
const ALERT_MS = (parseInt(process.env.QUIZ_POOL_ALERT_COOLDOWN_HOURS, 10) || 6) * 3600 * 1000;
const CHECK_MS = 60 * 1000; // count at most once per language per minute (bounds DB load)

const _lastCheck = new Map(); // lang -> ms (throttles the count)
const _lastAlert = new Map(); // lang -> ms (throttles the email + notification)

/**
 * Check the fresh-pool size for `lang` given this player's already-seen `used` ids,
 * and alert if it's at/under the threshold. Fire-and-forget; returns a promise that
 * always resolves.
 */
async function maybeAlertLowPool(lang, used) {
  try {
    if (!lang) return;
    const now = Date.now();
    if (now - (_lastCheck.get(lang) || 0) < CHECK_MS) return; // count throttle
    _lastCheck.set(lang, now);

    const remaining = await QuizQuestion.countDocuments({ isActive: true, language: lang, _id: { $nin: used || [] } });
    if (remaining > THRESHOLD) return; // pool healthy → nothing to do

    if (now - (_lastAlert.get(lang) || 0) < ALERT_MS) return; // alert throttle (anti-spam)
    _lastAlert.set(lang, now); // set BEFORE sending so concurrent hits don't double-fire

    await Promise.allSettled([_notifyAdmin(lang, remaining), _emailSupport(lang, remaining)]);
  } catch (e) {
    // Alerting is best-effort — swallow everything so gameplay is never affected.
    try { console.error('quiz pool alert:', e && e.message); } catch (_) { /* noop */ }
  }
}

async function _notifyAdmin(lang, remaining) {
  await Notification.create({
    title: `⚠️ Quiz pool low: ${String(lang).toUpperCase()} (${remaining} left)`,
    message: `Only ${remaining} unseen active question(s) remain for language "${lang}" (threshold ${THRESHOLD}). With lifetime no-repeat each player consumes the pool permanently — please upload more ACTIVE "${lang}" questions to avoid "No question available today".`,
    type: 'admin',
    priority: remaining === 0 ? 'urgent' : 'high',
    sentBy: 'system',
  });
}

async function _emailSupport(lang, remaining) {
  const to = process.env.QUIZ_ALERT_EMAIL || process.env.SUPPORT_EMAIL;
  if (!to || !email.isConfigured()) return; // no recipient / SMTP not set → skip quietly
  const subject = `⚠️ Daily Quiz low pool: "${lang}" — ${remaining} question(s) left`;
  const text =
    `The Daily Quiz question pool for language "${lang}" is nearly exhausted.\n\n` +
    `Unseen active questions remaining (for an active player): ${remaining}\n` +
    `Alert threshold: ${THRESHOLD}\n\n` +
    `Why: lifetime no-repeat means every account permanently consumes questions.\n` +
    `Action: upload more ACTIVE questions for "${lang}" so players keep getting fresh ones.`;
  await email.sendMail({
    to,
    subject,
    text,
    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
      <h3 style="color:#E31E24;margin:0 0 8px">⚠️ Daily Quiz — low question pool</h3>
      <p>Language: <b>${lang}</b></p>
      <p>Unseen active questions remaining: <b style="font-size:18px">${remaining}</b> (threshold ${THRESHOLD})</p>
      <p style="color:#555">Lifetime no-repeat means every account permanently consumes questions.</p>
      <p><b>Action:</b> upload more active "${lang}" questions so players keep getting fresh ones.</p></div>`,
  });
}

// Test seam.
function _resetThrottle() { _lastCheck.clear(); _lastAlert.clear(); }

module.exports = { maybeAlertLowPool, THRESHOLD, _resetThrottle };
