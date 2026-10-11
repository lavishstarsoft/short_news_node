'use strict';

/**
 * Our OWN push transport via Firebase Cloud Messaging (FCM) — free & unlimited,
 * the same pipe OneSignal uses internally, minus the 10k-active-user paywall.
 *
 * We send DATA-ONLY messages. The Flutter app's firebase_messaging background
 * handler receives the data and draws the notification with
 * flutter_local_notifications — so every look the desk already has (the 18
 * Notification Studio designs, colours, big-picture image, buttons, polls,
 * big/small titles) renders EXACTLY as today. The transport never draws the UI;
 * the app does, from this payload. That is why nothing visual changes.
 *
 * Targeting mirrors OneSignal 1:1 using FCM topics:
 *   OneSignal tag  news_language = te   →  FCM topic  "news_te"
 *   OneSignal (no language / broadcast) →  FCM topic  "news_all"
 *   OneSignal external_id = <adminId>   →  FCM topic  "user_<adminId>"
 * The app subscribes to its language topic + its own user topic at sign-in.
 *
 * SAFETY (so this can ship dark and never hurt the live app):
 *   • Disabled unless  FCM_PUSH_ENABLED=true  AND a service account is loaded.
 *   • Every send swallows its own errors and returns a result object; it never
 *     throws, so a push failure can never break publishing or an approve/reject.
 */

let _admin = null;
let _messaging = null;
let _state = 'uninit'; // 'uninit' | 'ready' | 'disabled'

function enabled() {
  return String(process.env.FCM_PUSH_ENABLED || '').trim().toLowerCase() === 'true';
}

// Lazy, one-time init. Keeps cold starts and tests hang-free when FCM is off.
function init() {
  if (_state !== 'uninit') return;
  try {
    if (!enabled()) { _state = 'disabled'; return; }
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      // Credential source: an explicit JSON path, else Application Default
      // Credentials (GOOGLE_APPLICATION_CREDENTIALS). The owner places the file;
      // this module only reads a path from env, never a secret value.
      const p = process.env.FCM_SERVICE_ACCOUNT_PATH;
      if (p) {
        const path = require('path');
        const serviceAccount = require(path.isAbsolute(p) ? p : path.resolve(process.cwd(), p));
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      } else {
        admin.initializeApp(); // uses GOOGLE_APPLICATION_CREDENTIALS if set
      }
    }
    _admin = admin;
    _messaging = admin.messaging();
    _state = 'ready';
    console.log('[fcm] initialized — own push transport ready');
  } catch (e) {
    _state = 'disabled';
    console.error('[fcm] init failed, FCM disabled:', e && e.message);
  }
}

function isReady() { init(); return _state === 'ready'; }

// FCM data payloads must be a flat map of string → string. Objects (e.g. the
// Studio's `nx`) are JSON-stringified; the app JSON-parses them back.
function stringifyData(obj = {}) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'string' ? v
      : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return out;
}

// FCM topics allow only [a-zA-Z0-9-_.~%]. Anything else → underscore.
function sanitizeTopic(s) {
  return String(s || '').trim().replace(/[^a-zA-Z0-9\-_.~%]/g, '_');
}

function languageTopic(lang) {
  const l = String(lang || '').trim().toLowerCase();
  return l ? 'news_' + sanitizeTopic(l) : 'news_all';
}

function userTopic(userId) {
  const id = sanitizeTopic(userId);
  return id ? 'user_' + id : null;
}

/**
 * Low-level: send a data-only message to one topic. Never throws.
 * @returns {Promise<{ok:boolean, messageId?:string, skipped?:string, error?:string}>}
 */
async function sendToTopic(topic, { title, message, data } = {}) {
  if (!isReady()) return { ok: false, skipped: 'fcm_disabled' };
  if (!topic) return { ok: false, skipped: 'no_topic' };
  try {
    const payload = {
      topic,
      data: stringifyData({ title: title || '', message: message || '', ...(data || {}) }),
      android: { priority: 'high' }, // deliver promptly even when app is backgrounded
    };
    const messageId = await _messaging.send(payload);
    return { ok: true, messageId };
  } catch (e) {
    console.error(`[fcm] send to ${topic} failed:`, e && e.message);
    return { ok: false, error: (e && e.message) || 'send_failed' };
  }
}

/** Broadcast news to one language audience (OneSignal news_language tag). */
function sendNewsToLanguage(lang, body) {
  return sendToTopic(languageTopic(lang), body);
}

/** Broadcast to everyone, regardless of language. */
function sendToAll(body) {
  return sendToTopic('news_all', body);
}

/** Push to one person's devices (OneSignal external_id). */
function sendToUser(userId, body) {
  const t = userTopic(userId);
  if (!t) return Promise.resolve({ ok: false, skipped: 'no_user' });
  return sendToTopic(t, body);
}

/**
 * Token-based multicast send → returns a REAL delivered count.
 *
 * FCM *topic* sends give no count; sending to individual device tokens does.
 * Batches of 500 (the FCM multicast limit). Reports back the tokens FCM says are
 * dead so the caller can prune them. Never throws.
 * @returns {Promise<{ok:boolean, successCount:number, failureCount:number, invalidTokens:string[], skipped?:string}>}
 */
async function sendToTokens(tokens, { title, message, data } = {}) {
  if (!isReady()) return { ok: false, skipped: 'fcm_disabled', successCount: 0, failureCount: 0, invalidTokens: [] };
  const list = Array.isArray(tokens) ? tokens.filter(Boolean) : [];
  if (!list.length) return { ok: true, successCount: 0, failureCount: 0, invalidTokens: [] };
  let successCount = 0;
  let failureCount = 0;
  const invalidTokens = [];
  const payloadData = stringifyData({ title: title || '', message: message || '', ...(data || {}) });
  for (let i = 0; i < list.length; i += 500) {
    const batch = list.slice(i, i + 500);
    try {
      const resp = await _messaging.sendEachForMulticast({
        tokens: batch,
        data: payloadData,
        android: { priority: 'high' },
      });
      successCount += resp.successCount || 0;
      failureCount += resp.failureCount || 0;
      (resp.responses || []).forEach((r, idx) => {
        if (!r || r.success) return;
        const code = r.error && r.error.code;
        if (code === 'messaging/registration-token-not-registered'
          || code === 'messaging/invalid-registration-token'
          || code === 'messaging/invalid-argument') {
          invalidTokens.push(batch[idx]);
        }
      });
    } catch (e) {
      console.error('[fcm] multicast batch failed:', e && e.message);
      failureCount += batch.length;
    }
  }
  return { ok: true, successCount, failureCount, invalidTokens };
}

module.exports = {
  enabled,
  isReady,
  sendToTopic,
  sendNewsToLanguage,
  sendToAll,
  sendToUser,
  sendToTokens,
  // exported for unit tests (no credentials needed)
  _test: { stringifyData, sanitizeTopic, languageTopic, userTopic },
};
