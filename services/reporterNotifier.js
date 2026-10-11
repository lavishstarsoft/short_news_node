'use strict';

/**
 * Push notifications to the REPORTER who filed a story, when the desk acts on
 * it (approve / reject / send back for revision / revert).
 *
 * Targeting: OneSignal `external_id` — the reporter app calls
 * `OneSignal.login(<reporterId>)` at sign-in, so one reporter's devices are
 * addressable by their Admin _id. No player-ids stored on our side.
 *
 * ALWAYS fire-and-forget: every function swallows its errors, so a push
 * failure can never break an approve/reject for the desk.
 */

const OneSignal = require('@onesignal/node-onesignal');
const mongoose = require('mongoose');

const TYPE = 'reporter_workflow';

/**
 * The reporter's working language, best-effort. Included in the push payload
 * because OLDER app builds only display pushes that carry a `language`
 * matching the phone's news language (the news-feed filter). Never throws and
 * never touches Mongo unless a connection is already open (keeps tests and
 * cold starts hang-free).
 */
async function defaultLookupLanguage(reporterId) {
  try {
    if (mongoose.connection.readyState !== 1) return null;
    const Admin = require('../models/Admin');
    const me = await Admin.findById(reporterId).select('workingLanguage').lean();
    const lang = me && me.workingLanguage ? String(me.workingLanguage).trim().toLowerCase() : '';
    return lang || null;
  } catch (_) {
    return null;
  }
}

/** Trim a headline for a notification body. */
function short(text, max = 90) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Message copy per event (English).
 * @returns {{title: string, message: string}|null}
 */
function buildMessage(event, { title, reason, remarks, message } = {}) {
  const head = short(title);
  switch (event) {
    case 'message': {
      // Admin → reporter personal message: subject as the title, body as text.
      const body = short(message || remarks, 120);
      return {
        title: head || 'Message from Tehelka News',
        message: body || 'You have a new message from the desk.',
      };
    }
    case 'approved':
      return {
        title: 'News approved ✅',
        message: head ? `Your news has been published: ${head}` : 'Your news has been published.',
      };
    case 'rejected': {
      const why = short(reason, 70);
      return {
        title: 'News rejected ❌',
        message: why
          ? `${head ? `${head} — ` : ''}Reason: ${why}`
          : `${head ? `${head} — ` : ''}Your news was rejected.`,
      };
    }
    case 'needs_revision': {
      const note = short(remarks, 70);
      return {
        title: 'Changes requested ✏️',
        message: note
          ? `${head ? `${head} — ` : ''}${note}`
          : `${head ? `${head} — ` : ''}Please make the requested changes.`,
      };
    }
    case 'reverted':
      return {
        title: 'Back to pending ↩️',
        message: head ? `Your news is back in pending: ${head}` : 'Your news is back in pending.',
      };
    default:
      return null;
  }
}

function getClient() {
  const appId = process.env.ONESIGNAL_APP_ID;
  const apiKey = process.env.ONESIGNAL_API_KEY;
  if (!appId || !apiKey) return null;
  try {
    const configuration = OneSignal.createConfiguration({
      restApiKey: apiKey,
      basePath: 'https://api.onesignal.com',
    });
    return { api: new OneSignal.DefaultApi(configuration), appId };
  } catch (_) {
    return null;
  }
}

/**
 * Notify one reporter about one story. Never throws.
 *
 * @param {'approved'|'rejected'|'needs_revision'|'reverted'} event
 * @param {{reporterId: string|object, newsId?: string|object, title?: string,
 *          reason?: string, remarks?: string}} payload
 * @returns {Promise<{sent: boolean, skipped?: string}>}
 */
async function notifyReporter(event, payload = {}, deps = {}) {
  try {
    const reporterId = payload.reporterId ? String(payload.reporterId) : '';
    if (!reporterId) return { sent: false, skipped: 'no_reporter' };

    const copy = (deps.buildMessage || buildMessage)(event, payload);
    if (!copy) return { sent: false, skipped: 'unknown_event' };

    const client = (deps.getClient || getClient)();
    if (!client) return { sent: false, skipped: 'onesignal_not_configured' };

    const language = payload.language || (await (deps.lookupLanguage || defaultLookupLanguage)(reporterId));

    const notification = new OneSignal.Notification();
    notification.app_id = client.appId;
    notification.headings = { en: copy.title };
    notification.contents = { en: copy.message };
    // Address the reporter by the external id the app logs in with.
    notification.target_channel = 'push';
    notification.include_aliases = { external_id: [reporterId] };
    notification.data = {
      type: TYPE,
      status: event,
      newsId: payload.newsId ? String(payload.newsId) : '',
      // The app routes this to the reporter's My Stories page.
      route: 'reporter_stories',
      // Lets older app builds (news-language filter) still display it.
      ...(language ? { language } : {}),
    };

    // OneSignal send switch (default ON) — FCM below still delivers when off.
    if (String(process.env.ONESIGNAL_SEND_ENABLED || 'false').trim().toLowerCase() === 'true') {
      await client.api.createNotification(notification);
    }

    // Our own FCM transport (free, unlimited) — additive, flag-gated, never throws.
    // Targets the reporter's personal topic user_<reporterId>; same data the app reads.
    try {
      const fcm = require('./fcmService');
      if (fcm.isReady()) {
        await fcm.sendToUser(reporterId, {
          title: copy.title,
          message: copy.message,
          data: {
            type: TYPE,
            status: event,
            newsId: payload.newsId ? String(payload.newsId) : '',
            route: 'reporter_stories',
            ...(language ? { language } : {}),
          },
        });
      }
    } catch (_) { /* never let a push failure break the desk action */ }

    return { sent: true };
  } catch (error) {
    console.error(`[reporterNotifier] ${event} push failed:`, error && error.message);
    return { sent: false, skipped: 'error' };
  }
}

/** Fire-and-forget wrapper — safe to call without awaiting. */
function notifyReporterAsync(event, payload, deps) {
  Promise.resolve()
    .then(() => notifyReporter(event, payload, deps))
    .catch(() => {});
}

module.exports = { notifyReporter, notifyReporterAsync, buildMessage, TYPE };
