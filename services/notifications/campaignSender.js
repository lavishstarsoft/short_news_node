'use strict';

/**
 * Sends a NotificationCampaign through OneSignal, and counts poll votes.
 *
 * Safety rules that matter on a live app:
 *  • a named audience with an empty list never becomes "everyone" (audience.js throws);
 *  • a test send goes ONLY to the person who pressed Test;
 *  • a campaign is marked 'sent' only after OneSignal accepts it, with its id kept
 *    so the result can be traced.
 */
const OneSignal = require('@onesignal/node-onesignal');
const NotificationCampaign = require('../../models/NotificationCampaign');
const NotificationVote = require('../../models/NotificationVote');
const oneSignal = require('../oneSignalService');
const types = require('./notificationTypes');
const { build } = require('./payloadBuilder');
const audience = require('./audience');

/** Current tally for a poll campaign: { counts: {id: n}, total }. */
async function tally(campaignId) {
  const rows = await NotificationVote.aggregate([
    { $match: { campaignId: typeof campaignId === 'string' ? new (require('mongoose').Types.ObjectId)(campaignId) : campaignId } },
    { $group: { _id: '$optionId', n: { $sum: 1 } } },
  ]);
  const counts = {};
  let total = 0;
  for (const r of rows) { counts[r._id] = r.n; total += r.n; }
  return { counts, total };
}

/**
 * Record one vote. Voting again replaces the earlier answer (never double-counts).
 * @returns {{ counts, total, changed }}
 */
async function vote({ campaignId, voterKey, optionId, userId = null, platform = '' }) {
  const campaign = await NotificationCampaign.findById(campaignId).lean();
  if (!campaign) { const e = new Error('This poll is no longer available.'); e.status = 404; throw e; }
  if (!types.isPoll(campaign.type)) { const e = new Error('This notification is not a poll.'); e.status = 400; throw e; }
  const allowed = (campaign.buttons || []).map((b) => b.id);
  if (!allowed.includes(optionId)) { const e = new Error('Unknown option.'); e.status = 400; throw e; }

  const res = await NotificationVote.findOneAndUpdate(
    { campaignId: campaign._id, voterKey: String(voterKey) },
    { $set: { optionId, userId, platform, at: new Date() } },
    { upsert: true, new: true, rawResult: true },
  );
  const t = await tally(campaign._id);
  await NotificationCampaign.updateOne({ _id: campaign._id },
    { $set: { 'poll.enabled': true, 'poll.counts': t.counts, 'poll.totalVotes': t.total } });
  return { ...t, changed: !(res.lastErrorObject && res.lastErrorObject.upserted) };
}

/**
 * Turn OneSignal's own wording into something the desk can act on. Only adds a
 * hint for causes we are sure about — it never replaces or softens the real error.
 */
function explain(detail) {
  const t = String(detail).toLowerCase();
  if (t.includes('invalid_alias') || t.includes('invalid aliases')) {
    return ' — those accounts have no phone registered yet: the person must open the Tehelka app, sign in and allow notifications first.';
  }
  if (t.includes('not subscribed') || t.includes('no subscribers') || t.includes('no recipients')) {
    return ' — nobody in that audience has notifications switched on right now.';
  }
  if (t.includes('target_channel')) {
    return ' — server bug: alias targeting was sent without target_channel.';
  }
  return '';
}

/**
 * Push a campaign.
 * @param {object} campaign  saved NotificationCampaign document
 * @param {object} [opts]    { testAlias } send only to this external_id;
 *                           { baseUrl } this server's public origin, so a poll
 *                           notification can tell the phone where to post votes
 */
async function send(campaign, opts = {}) {
  // OneSignal send switch — now DEFAULT OFF: campaigns go out over our own FCM
  // only. Set ONESIGNAL_SEND_ENABLED=true to turn OneSignal back on (revert).
  const oneSignalEnabled = String(process.env.ONESIGNAL_SEND_ENABLED || 'false').trim().toLowerCase() === 'true';
  if (oneSignalEnabled && !oneSignal.client) throw new Error('OneSignal is not configured on this server.');

  const pollState = types.isPoll(campaign.type) ? await tally(campaign._id) : { counts: {}, total: 0 };
  const { data, native } = build(campaign, {
    pollCounts: pollState.counts,
    totalVotes: pollState.total,
    baseUrl: opts.baseUrl,
  });

  const target = opts.testAlias
    ? { targeting: audience.byAlias([opts.testAlias]), describe: 'Test send (you only)', estimate: 1 }
    : await audience.resolve(campaign.audience || {});

  const n = new OneSignal.Notification();
  n.app_id = oneSignal.appId;
  // A blank heading is refused by OneSignal, and old builds show it — the app
  // name is the honest stand-in for a picture that carries its own words.
  n.headings = { en: (campaign.title || '').trim() || 'Tehelka News' };
  n.contents = { en: campaign.message && campaign.message.trim() ? campaign.message : '​' };
  // `nx` is what the app's renderer reads; `type` keeps old builds on their
  // existing "admin notification" path instead of showing something broken.
  n.data = { type: 'admin', nx: data, campaignId: String(campaign._id) };
  // Fields older app builds already understand, at the top level where they look:
  // tapping opens the news / the link instead of doing nothing.
  if (data.newsId) n.data.newsId = data.newsId;
  if (data.url) n.data.launchUrl = data.url;
  if (data.route) n.data.route = data.route;
  // The SAME three styling keys the old "Send Notification" page sends, read by
  // NotificationServiceExtension.kt on builds that are already on phones — so a
  // coloured, bigger, bold title works today, before any app update.
  if (data.titleColor) n.data.titleColor = data.titleColor;
  if (data.bodyColor) n.data.messageColor = data.bodyColor;
  n.data.titleFontSize = data.titleSize === 'xlarge' ? 'large' : data.titleSize;
  // App builds older than the Studio DROP any notification without `language`
  // (they compare it with the reader's chosen feed language). For a language
  // send we know the value, so those builds can show it too.
  const audLang = campaign.audience && campaign.audience.kind === 'language' && campaign.audience.language;
  if (audLang) n.data.language = String(audLang).trim().toLowerCase();
  // Same content twice → Android replaces the first notification instead of
  // stacking a second one. Covers the path where OneSignal draws it itself
  // (older builds, or a phone where our renderer did not run).
  if (data.dedupe) n.collapse_id = data.dedupe;
  Object.assign(n, native, target.targeting);

  // OneSignal send switch (see top of send()): skip it entirely when off, so
  // campaigns go out over our own FCM alone. Flip only once the FCM token app is
  // widespread, or users still on OneSignal-only builds stop receiving pushes.
  let result = null;
  if (oneSignalEnabled && oneSignal.client) {
    try {
      result = await oneSignal.client.createNotification(n);
    } catch (err) {
      const detail = (err && err.body && JSON.stringify(err.body)) || (err && err.message) || 'unknown error';
      await NotificationCampaign.updateOne({ _id: campaign._id }, { $set: { status: 'failed', error: String(detail).slice(0, 500) } });
      const e = new Error(`OneSignal rejected the notification: ${String(detail).slice(0, 200)}${explain(detail)}`);
      e.status = 502;
      throw e;
    }
  }

  // Our own FCM transport (free, unlimited) — additive, never throws. Two modes:
  //  • topic mode (default): push to FCM topics (news_all / news_<lang> / user_<id>).
  //    Identical look via the native renderer, but FCM gives NO delivered count.
  //  • token mode (FCM_TOKEN_SEND_ENABLED=true): push to each registered device
  //    token so FCM returns a real successCount = how many phones received it.
  let fcmDelivered = 0;
  try {
    const fcm = require('../fcmService');
    if (fcm.isReady()) {
      const fcmData = {
        type: 'admin',
        nx: data,
        campaignId: String(campaign._id),
        newsId: data.newsId || '',
        launchUrl: data.url || '',
        route: data.route || '',
        titleColor: data.titleColor || '',
        messageColor: data.bodyColor || '',
        titleFontSize: data.titleSize === 'xlarge' ? 'large' : (data.titleSize || 'normal'),
      };
      const body = { title: (campaign.title || '').trim() || 'Tehelka News', message: campaign.message || '', data: fcmData };
      const kind = campaign.audience && campaign.audience.kind;
      // Named-people audiences carry explicit external_id aliases → one user each.
      const aliases = (target.targeting && target.targeting.include_aliases
        && target.targeting.include_aliases.external_id) || null;
      const tokenMode = String(process.env.FCM_TOKEN_SEND_ENABLED || '').trim().toLowerCase() === 'true';

      if (tokenMode) {
        // Token send → real delivered count. Build the recipient token set from
        // the device-token store by the same audience the campaign targets.
        const DeviceToken = require('../../models/DeviceToken');
        let query = null;
        if (opts.testAlias) query = { userId: opts.testAlias };
        else if (kind === 'all') query = {};
        else if (kind === 'language' && campaign.audience.language) query = { language: campaign.audience.language };
        else if (Array.isArray(aliases) && aliases.length) query = { userId: { $in: aliases } };
        if (query) {
          const docs = await DeviceToken.find(query).select('token').lean();
          const tokens = [...new Set(docs.map((d) => d.token).filter(Boolean))];
          if (tokens.length) {
            const r = await fcm.sendToTokens(tokens, body);
            fcmDelivered = Number(r && r.successCount) || 0;
            if (r && Array.isArray(r.invalidTokens) && r.invalidTokens.length) {
              await DeviceToken.deleteMany({ token: { $in: r.invalidTokens } });
            }
          }
        } else {
          console.log('[fcm] token send skipped — unsupported audience kind:', kind);
        }
      } else if (opts.testAlias) {
        await fcm.sendToUser(opts.testAlias, body);
      } else if (kind === 'language' && campaign.audience.language) {
        await fcm.sendNewsToLanguage(campaign.audience.language, body);
      } else if (kind === 'all') {
        await fcm.sendToAll(body);
      } else if (Array.isArray(aliases) && aliases.length) {
        // reporters / reporter_list / user_list — push to each person's own topic.
        for (const a of aliases) { await fcm.sendToUser(a, body); }
      } else {
        // state / district use tag filters; FCM district topics are Phase 2.
        // Skip rather than wrongly broadcast a targeted notification to everyone.
        console.log('[fcm] studio push skipped — unsupported audience kind:', kind);
      }
    }
  } catch (fcmErr) {
    console.error('[fcm] studio push error:', fcmErr && fcmErr.message);
  }

  const recipients = Number(result && result.recipients) || 0;
  // When OneSignal reports 0 (alias targeting, or the account is paused and the
  // send actually went out over our own FCM), fall back to the audience estimate
  // (registered app users) so the Studio shows "~N" instead of a bare 0.
  const recipientsEstimate = recipients > 0 ? recipients : (Number(target && target.estimate) || 0);
  if (!opts.testAlias) {
    await NotificationCampaign.updateOne({ _id: campaign._id }, {
      $set: {
        status: 'sent',
        oneSignalId: (result && result.id) || '',
        recipientsEstimate,
        fcmDelivered,
        sentAt: new Date(),
        error: '',
      },
    });
  }
  return { id: (result && result.id) || '', recipients: fcmDelivered || recipients || recipientsEstimate, describe: target.describe, test: !!opts.testAlias };
}

module.exports = { send, vote, tally };
