'use strict';

/**
 * Notification Studio (/admin/notification-studio) — pick one of the 18 designs,
 * choose who gets it, preview it, test it on your own phone, then send.
 *
 * Additive: the old "Send Notification" page and its API are untouched.
 */
const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Location = require('../models/Location');
const NotificationCampaign = require('../models/NotificationCampaign');
const types = require('../services/notifications/notificationTypes');
const sender = require('../services/notifications/campaignSender');
const audience = require('../services/notifications/audience');
const { build } = require('../services/notifications/payloadBuilder');
const { logAudit } = require('../utils/auditLogger');

const str = (v, n = 300) => String(v == null ? '' : v).trim().slice(0, n);
const objectIds = (arr, max = 500) => (Array.isArray(arr) ? arr : [])
  .map((x) => String(x))
  .filter((x) => mongoose.Types.ObjectId.isValid(x))
  .slice(0, max)
  .map((x) => new mongoose.Types.ObjectId(x));

/**
 * Admins and Super Admins only. requireAdmin already enforces this on the route;
 * checked again here so the send path is never reachable by a future route that
 * forgets the middleware.
 */
function canSend(req) {
  const role = (req.admin || {}).role;
  return role === 'admin' || role === 'superadmin';
}

/** Request body → a campaign shape we are willing to save. Never trusts extra fields. */
function fromBody(body = {}) {
  const def = types.get(body.type);
  if (!def) { const e = new Error('Choose a notification design.'); e.status = 400; throw e; }
  const title = str(body.title, 120);
  if (!title && types.needsTitle(def.key)) {
    const e = new Error('Title is required.'); e.status = 400; throw e;
  }
  if (!str(body.imageUrl, 500) && (def.needs || []).includes('imageUrl') && def.noTitle) {
    const e = new Error('This design needs a picture — paste an image link or upload one.');
    e.status = 400; throw e;
  }

  const max = types.maxButtons(def.key);
  const buttons = (Array.isArray(body.buttons) ? body.buttons : []).slice(0, max)
    .filter((b) => b && str(b.label))
    .map((b, i) => ({
      id: str(b.id, 40) || `opt_${i}`,
      label: str(b.label, 40),
      color: str(b.color, 9),
      icon: str(b.icon, 8),
      action: str(b.action, 10) || 'open',
      url: str(b.url, 400),
    }));

  const a = body.audience || {};
  return {
    type: def.key,
    title,
    message: str(body.message, 300),
    imageUrl: str(body.imageUrl, 500),
    thumbnailUrl: str(body.thumbnailUrl, 500),
    titleColor: str(body.titleColor, 9),
    messageColor: str(body.messageColor, 9),
    titleSize: ['small', 'normal', 'large', 'xlarge'].includes(str(body.titleSize, 10)) ? str(body.titleSize, 10) : 'normal',
    titleBold: body.titleBold !== false,
    accentColor: str(body.accentColor, 9),
    emoji: str(body.emoji, 8),
    buttons,
    chips: (Array.isArray(body.chips) ? body.chips : []).slice(0, 6).map((c) => str(c, 24)).filter(Boolean),
    launchUrl: str(body.launchUrl, 400),
    route: types.isRoute(body.route) ? str(body.route, 30) : '',
    newsId: mongoose.Types.ObjectId.isValid(body.newsId) ? new mongoose.Types.ObjectId(body.newsId) : null,
    silent: body.silent === true || def.silent === true,
    // Tappable areas drawn on the picture; the payload builder clamps and
    // drops any that would do nothing.
    hotspots: (Array.isArray(body.hotspots) ? body.hotspots : []).slice(0, 12).map((h) => ({
      x: Number(h && h.x) || 0,
      y: Number(h && h.y) || 0,
      w: Number(h && h.w) || 0,
      h: Number(h && h.h) || 0,
      action: ['open', 'link', 'route', 'vote'].includes(h && h.action) ? h.action : 'open',
      value: str(h && h.value, 400),
      label: str(h && h.label, 60),
    })),
    expireHours: Math.min(168, Math.max(0, Number(body.expireHours) || 0)),
    ongoing: body.ongoing === true,
    urgent: body.urgent === true || def.urgent === true,
    progress: {
      current: Number.isFinite(Number(body.progress && body.progress.current)) ? Number(body.progress.current) : null,
      total: Number.isFinite(Number(body.progress && body.progress.total)) ? Number(body.progress.total) : null,
      label: str(body.progress && body.progress.label, 80),
    },
    audience: {
      kind: str(a.kind, 20) || 'all',
      language: str(a.language, 30),
      state: str(a.state, 60),
      district: str(a.district, 60),
      reporterIds: objectIds(a.reporterIds),
      userIds: objectIds(a.userIds),
    },
    poll: { enabled: types.isPoll(def.key) },
  };
}

exports.renderPage = (req, res) => {
  res.render('notification-studio', {
    title: 'Notification Studio',
    admin: req.admin,
    activePage: 'notification-studio',
    notificationTypes: types.TYPES,
  });
};

/** Designs + the lists the audience picker needs. */
exports.getOptions = async (req, res) => {
  try {
    const states = await Location.distinct('name', { locationType: 'state' }).catch(() => []);
    let languages = [];
    try {
      languages = require('../services/languageRegistry').getActiveLanguages() || [];
    } catch (_) {
      languages = []; // the picker simply falls back to Telugu in the page
    }
    res.json({
      types: types.TYPES,
      appRoutes: types.APP_ROUTES,
      states: states.sort(),
      languages: languages.map((l) => ({ code: l.code, name: l.nativeName || l.name })),
    });
  } catch (e) {
    console.error('studio options failed:', e);
    res.status(500).json({ error: 'Could not load the options.' });
  }
};

/** Districts of one state, for the audience picker. */
exports.getDistricts = async (req, res) => {
  try {
    const state = str(req.query.state, 60);
    if (!state) return res.json({ districts: [] });
    const districts = await Location.distinct('name', { locationType: 'district', parentName: state });
    res.json({ districts: districts.sort() });
  } catch (e) {
    res.status(500).json({ error: 'Could not load districts.' });
  }
};

/** Type-ahead over reporters or app users, for "send to these people". */
exports.searchPeople = async (req, res) => {
  try {
    const q = str(req.query.q, 60);
    const who = req.query.who === 'user' ? 'user' : 'reporter';
    if (q.length < 2) return res.json({ people: [] });
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (who === 'reporter') {
      const rows = await Admin.find({ role: { $in: ['editor', 'subeditor'] }, $or: [{ name: rx }, { username: rx }, { mobileNumber: rx }] })
        .select('name username mobileNumber assignedState assignedDistricts isActive').limit(20).lean();
      return res.json({
        people: rows.map((r) => ({
          id: String(r._id), name: r.name || r.username, sub: [r.mobileNumber, (r.assignedDistricts || [])[0] || r.assignedState].filter(Boolean).join(' · '),
          inactive: r.isActive === false,
        })),
      });
    }
    const rows = await User.find({ $or: [{ displayName: rx }, { email: rx }, { mobileNumber: rx }] })
      .select('displayName email mobileNumber locationProfile.primaryDistrict').limit(20).lean();
    res.json({
      people: rows.map((u) => ({
        id: String(u._id), name: u.displayName || u.email || 'User',
        sub: [u.mobileNumber, u.email, u.locationProfile && u.locationProfile.primaryDistrict].filter(Boolean).join(' · '),
      })),
    });
  } catch (e) {
    console.error('people search failed:', e);
    res.status(500).json({ error: 'Search failed.' });
  }
};

/**
 * Recent published news, for "attach this article".
 *
 * Attaching one is what makes a TAP open that article in the app — without a
 * newsId the notification can only open the app itself.
 */
exports.searchNews = async (req, res) => {
  try {
    const News = require('../models/News');
    const q = str(req.query.q, 60);
    const language = str(req.query.language, 16); // additive: filter by language code (e.g. te/hi/ta/en)
    const filter = { isActive: true };
    if (q) filter.title = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (language) filter.language = language; // News.language stores the code

    const rows = await News.find(filter)
      .select('title content imageUrl imageUrls mediaUrl mediaType thumbnailUrl category location language publishedAt')
      .sort({ publishedAt: -1 })
      .limit(q ? 20 : 60) // language-only listing (3D Ads picker) returns more
      .lean();

    res.json({
      news: rows.map((n) => ({
        id: String(n._id),
        title: n.title || '',
        // The app shows ~2 lines under the headline; send a sensible default.
        summary: String(n.content || '').trim().slice(0, 160),
        // Full body (capped) so the 3D-Ads device-coverage preview can measure
        // how much description there is per device/language. Additive field.
        content: String(n.content || '').trim().slice(0, 1500),
        image: n.mediaType === 'video'
          ? (n.thumbnailUrl || n.imageUrl || '')
          : (n.mediaUrl || n.imageUrl || (n.imageUrls || [])[0] || ''),
        isVideo: n.mediaType === 'video',
        language: n.language || '',
        sub: [n.category, n.location, n.language].filter(Boolean).join(' · '),
        publishedAt: n.publishedAt,
      })),
    });
  } catch (e) {
    console.error('news search failed:', e.message);
    res.status(500).json({ error: 'Could not load news.' });
  }
};

/** Upload a picture for the image / big-image designs (same store as ad media). */
exports.uploadImage = (req, res) => {
  if (!req.file || !req.file.path) return res.status(400).json({ error: 'No image uploaded.' });
  res.json({ ok: true, imageUrl: req.file.path, thumbnailUrl: req.file.thumbnailPath || req.file.path });
};

/** What the notification will look like + who it would reach. No send. */
exports.preview = async (req, res) => {
  try {
    const shape = fromBody(req.body);
    const { data, native } = build({ ...shape, _id: 'preview' });
    let describe = '';
    let estimate = null;
    try {
      const t = await audience.resolve(shape.audience);
      describe = t.describe;
      estimate = t.estimate;
    } catch (e) {
      describe = e.message;
    }
    res.json({ ok: true, preview: data, native, audience: { describe, estimate } });
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
};

/**
 * This server's public origin, for the vote endpoint carried inside a poll
 * notification. PUBLIC_BASE_URL / DASHBOARD_BASE_URL win; otherwise the host the
 * dashboard itself was reached on, which is the same origin the app calls.
 */
function publicBaseUrl(req) {
  const env = String(process.env.PUBLIC_BASE_URL || process.env.DASHBOARD_BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  const host = (req && req.get && req.get('host')) || '';
  return host ? `${(req && req.protocol) || 'https'}://${host}` : '';
}

/**
 * Which single phone a test send goes to: the person picked in the audience list
 * if there is one, otherwise the admin pressing Test (who must be signed into the
 * app with the same account for their phone to be known to OneSignal).
 */
async function testAliasFor(req, shape) {
  const a = shape.audience || {};
  const user = (a.userIds || [])[0];
  const reporter = (a.reporterIds || [])[0];
  if (a.kind === 'user_list' && user) {
    // A reader's alias is their Google id, which only the DB knows — reuse resolve()
    // rather than guessing it here.
    const t = await audience.resolve({ kind: 'user_list', userIds: [user] });
    return t.targeting.include_aliases.external_id[0];
  }
  if (a.kind === 'reporter_list' && reporter) return audience.aliasForReporter(reporter);
  return audience.aliasForReporter(req.admin.id || req.admin._id);
}

/** How long the same notification is treated as an accidental repeat. */
const REPEAT_WINDOW_MS = 2 * 60 * 1000;

/**
 * Was this exact notification just sent? Clicking Send twice because the first
 * one "looked like it did nothing" is the easiest way to spam every reader, so
 * the second one is refused unless the desk explicitly confirms.
 */
async function recentlySent(shape) {
  const since = new Date(Date.now() - REPEAT_WINDOW_MS);
  return NotificationCampaign.findOne({
    status: 'sent',
    type: shape.type,
    title: shape.title,
    message: shape.message,
    'audience.kind': shape.audience.kind,
    sentAt: { $gte: since },
  }).select('sentAt').lean();
}

/** Send for real, or (test=true) to exactly one phone. */
exports.send = async (req, res) => {
  if (!canSend(req)) return res.status(403).json({ error: 'You do not have permission to send notifications.' });
  try {
    const isTest = req.body.test === true;
    const shape = fromBody(req.body);
    if (!isTest) await audience.resolve(shape.audience); // fail before saving

    if (!isTest && req.body.confirmDuplicate !== true) {
      const already = await recentlySent(shape);
      if (already) {
        const secs = Math.max(1, Math.round((Date.now() - new Date(already.sentAt).getTime()) / 1000));
        return res.status(409).json({
          error: `This exact notification was already sent ${secs} seconds ago. Readers would get it twice.`,
          duplicate: true,
          secondsAgo: secs,
        });
      }
    }

    const campaign = await NotificationCampaign.create({
      ...shape,
      status: isTest ? 'test' : 'draft',
      sentBy: req.admin.id || req.admin._id || null,
      sentByName: req.admin.username || req.admin.name || '',
    });

    const result = await sender.send(campaign, {
      testAlias: isTest ? await testAliasFor(req, shape) : undefined,
      baseUrl: publicBaseUrl(req),
    });

    // A test that reached nobody almost always means that phone has never opened
    // the app while signed in — say so instead of reporting a silent success.
    if (isTest && !result.recipients) {
      return res.json({
        ok: true, ...result, campaignId: String(campaign._id),
        warning: 'Nothing was delivered: that account has no phone registered yet. Open the Tehelka app on the phone, sign in, allow notifications, then test again.',
      });
    }

    if (!isTest) {
      logAudit({
        req,
        action: 'notification_sent',
        entityType: 'NotificationCampaign',
        entityId: campaign._id,
        description: `Sent "${shape.type}" notification "${shape.title}" to ${result.describe} (${result.recipients} devices)`,
        after: { type: shape.type, audience: shape.audience.kind, recipients: result.recipients },
      });
    }
    res.json({ ok: true, ...result, campaignId: String(campaign._id) });
  } catch (e) {
    console.error('studio send failed:', e.message);
    res.status(e.status || 500).json({ error: e.message || 'Could not send the notification.' });
  }
};

/**
 * How many phones actually received a send.
 *
 * OneSignal answers 0 recipients at create time for alias targeting — the real
 * count only exists afterwards — so the desk had no way to tell a delivered
 * notification from one that reached nobody. This asks OneSignal directly.
 */
exports.deliveryReport = async (req, res) => {
  try {
    const campaign = await NotificationCampaign.findById(req.params.id).select('oneSignalId status recipientsEstimate fcmDelivered').lean();
    if (!campaign) return res.status(404).json({ error: 'Not found.' });
    // Our own FCM token send gives a real delivered count — show it first.
    if (Number(campaign.fcmDelivered) > 0) {
      return res.json({ ok: true, delivered: Number(campaign.fcmDelivered), fcm: true });
    }
    // No OneSignal id → the send went over our own FCM (topic-based, no delivered
    // count). Show the audience estimate ("~N") instead of a bare pending/0.
    if (!campaign.oneSignalId) {
      const est = Number(campaign.recipientsEstimate) || 0;
      if (est > 0) return res.json({ ok: true, delivered: est, estimate: true });
      return res.json({ ok: true, pending: true });
    }

    const oneSignal = require('../services/oneSignalService');
    if (!oneSignal.client) return res.json({ ok: true, pending: true });

    const r = await oneSignal.client.getNotification(oneSignal.appId, campaign.oneSignalId);
    const delivered = Number(r && r.successful) || 0;
    const failed = Number(r && r.failed) || 0;
    const errored = Number(r && r.errored) || 0;
    // Worth writing back: the desk sees the true number on the next page load
    // without asking OneSignal again.
    await NotificationCampaign.updateOne({ _id: campaign._id }, { $set: { recipientsEstimate: delivered } });
    res.json({ ok: true, delivered, failed, errored, remaining: Number(r && r.remaining) || 0 });
  } catch (e) {
    res.status(502).json({ error: 'OneSignal did not answer: ' + (e.message || 'unknown') });
  }
};

/** Recent sends + live poll results. */
exports.history = async (req, res) => {
  try {
    const rows = await NotificationCampaign.find({ status: { $in: ['sent', 'failed'] } })
      .sort({ createdAt: -1 }).limit(50).lean();
    res.json({
      campaigns: rows.map((c) => ({
        id: String(c._id),
        type: c.type,
        typeLabel: (types.get(c.type) || {}).label || c.type,
        title: c.title,
        status: c.status,
        audience: c.audience && c.audience.kind,
        recipients: Number(c.fcmDelivered) > 0 ? c.fcmDelivered : c.recipientsEstimate,
        poll: c.poll && c.poll.enabled
          ? { total: c.poll.totalVotes || 0, counts: c.poll.counts || {}, options: (c.buttons || []).map((b) => ({ id: b.id, label: b.label })) }
          : null,
        error: c.error || '',
        sentAt: c.sentAt || c.createdAt,
        sentByName: c.sentByName,
        hasReport: !!c.oneSignalId || Number(c.fcmDelivered) > 0,
        // Enough to refill the form with one click ("send this again").
        clone: {
          type: c.type, title: c.title, message: c.message, imageUrl: c.imageUrl,
          titleColor: c.titleColor, messageColor: c.messageColor, titleSize: c.titleSize,
          titleBold: c.titleBold, accentColor: c.accentColor, emoji: c.emoji,
          buttons: c.buttons || [], chips: c.chips || [], hotspots: c.hotspots || [],
          launchUrl: c.launchUrl || '', route: c.route || '',
          newsId: c.newsId ? String(c.newsId) : '',
          expireHours: c.expireHours || 0, ongoing: !!c.ongoing,
          audience: c.audience || { kind: 'all' },
        },
      })),
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load history.' });
  }
};

// ─── public (the app) ────────────────────────────────────────────────────────

/**
 * POST /api/public/notification/vote  { campaignId, optionId, voterKey }
 * One vote per person; voting again changes the answer.
 */
exports.publicVote = async (req, res) => {
  try {
    const campaignId = str(req.body.campaignId, 40);
    const optionId = str(req.body.optionId, 40);
    const voterKey = str(req.body.voterKey || req.headers['x-device-id'], 80);
    if (!mongoose.Types.ObjectId.isValid(campaignId)) return res.status(400).json({ error: 'Bad poll id.' });
    if (!optionId || !voterKey) return res.status(400).json({ error: 'Missing option or device.' });

    const userId = mongoose.Types.ObjectId.isValid(req.body.userId) ? new mongoose.Types.ObjectId(req.body.userId) : null;
    const out = await sender.vote({ campaignId, voterKey, optionId, userId, platform: str(req.body.platform, 20) });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not record your vote.' });
  }
};

/** GET /api/public/notification/poll/:id — current counts (for the app to show results). */
exports.publicPoll = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Bad poll id.' });
    const campaign = await NotificationCampaign.findById(req.params.id).select('type title buttons poll').lean();
    if (!campaign) return res.status(404).json({ error: 'Poll not found.' });
    const t = await sender.tally(campaign._id);
    res.json({
      ok: true,
      title: campaign.title,
      options: (campaign.buttons || []).map((b) => ({ id: b.id, label: b.label, votes: t.counts[b.id] || 0 })),
      total: t.total,
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load the poll.' });
  }
};
