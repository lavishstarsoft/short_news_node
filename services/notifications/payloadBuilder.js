'use strict';

/**
 * Campaign → OneSignal notification.
 *
 * The app draws its own notification (NotificationServiceExtension calls
 * preventDefault), so everything the phone needs to render a design travels in
 * `data.nx`. We ALSO fill the matching native OneSignal fields (big_picture,
 * buttons, priority…) so that an older app build — which knows nothing about
 * these designs — still shows a sensible notification instead of nothing.
 */
const types = require('./notificationTypes');

const str = (v, n = 300) => String(v == null ? '' : v).trim().slice(0, n);
const hex = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '').trim()) ? String(v).trim() : '');

const TITLE_SIZES = ['small', 'normal', 'large', 'xlarge'];
const size = (v) => (TITLE_SIZES.includes(String(v || '').trim()) ? String(v).trim() : 'normal');

/**
 * A key that is the SAME for two notifications with the same content, and
 * different for genuinely different ones.
 *
 * The phone uses it as the Android notification id and OneSignal uses it as the
 * collapse key, so sending the same thing twice REPLACES the first notification
 * instead of stacking a second one in the tray. Different campaigns with
 * different content keep their own notification, as they should.
 */
function dedupeKey(campaign) {
  const parts = [
    campaign.type,
    str(campaign.title, 120),
    str(campaign.message, 300),
    (campaign.audience && campaign.audience.kind) || 'all',
  ].join('|');
  // Small, stable, non-cryptographic — this only has to be consistent.
  let h = 5381;
  for (let i = 0; i < parts.length; i += 1) h = ((h * 33) ^ parts.charCodeAt(i)) >>> 0;
  return `nx${h.toString(36)}`;
}

/** Buttons the design allows, cleaned and capped. */
function cleanButtons(campaign) {
  const max = types.maxButtons(campaign.type);
  if (!max) return [];
  return (campaign.buttons || [])
    .filter((b) => b && str(b.label))
    .slice(0, max)
    .map((b, i) => ({
      id: str(b.id, 40) || `opt_${i}`,
      label: str(b.label, 40),
      color: hex(b.color),
      icon: str(b.icon, 8),
      action: ['open', 'vote', 'link', 'dismiss', 'remind'].includes(b.action) ? b.action : 'open',
      url: str(b.url, 400),
    }));
}

/** 0..1 rectangle, clamped so a stray value can never point off the picture. */
const unit = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
};

/**
 * Tappable areas on the picture. Anything without a real action is dropped —
 * an area that does nothing is worse than no area at all, because the reader
 * taps it and the notification just sits there.
 */
function cleanHotspots(campaign) {
  return (campaign.hotspots || [])
    .filter((s) => s && Number(s.w) > 0.01 && Number(s.h) > 0.01)
    .slice(0, 12)
    .map((s) => ({
      x: unit(s.x), y: unit(s.y), w: unit(s.w), h: unit(s.h),
      action: ['open', 'link', 'route', 'vote'].includes(s.action) ? s.action : 'open',
      value: str(s.value, 400),
    }))
    .filter((s) => s.action === 'open' || s.value);
}

/**
 * @param {object} campaign  a NotificationCampaign (plain object is fine)
 * @param {object} [opts]    { pollCounts, totalVotes }
 * @returns {{ data: object, native: object }}
 */
function build(campaign, opts = {}) {
  const def = types.get(campaign.type);
  if (!def) throw new Error(`Unknown notification type "${campaign.type}"`);

  // A design's own look (colour / emoji) applies whenever the desk left it blank,
  // so "Urgent" is always red and "Promotion" always warm, whoever sent it.
  const d = def.defaults || {};
  const buttons = cleanButtons(campaign);
  const silent = campaign.silent === true || def.silent === true;
  const urgent = campaign.urgent === true || def.urgent === true;

  // What the app reads to draw the design. Kept small — a push payload is capped
  // (~4 KB), so no long text and no base64 here.
  const nx = {
    v: 1,
    type: campaign.type,
    id: campaign._id ? String(campaign._id) : '',
    // The phone draws with THIS as the notification id, so the same content sent
    // twice replaces itself instead of appearing twice.
    dedupe: dedupeKey(campaign),
    title: str(campaign.title, 120),
    body: str(campaign.message, 300),
    image: str(campaign.imageUrl, 500),
    thumb: str(campaign.thumbnailUrl, 500),
    accent: hex(campaign.accentColor) || hex(campaign.titleColor) || hex(d.accentColor),
    emoji: str(campaign.emoji, 8) || str(d.emoji, 8),
    silent,
    urgent,
    // Title / message styling — the same three controls the old page has.
    // titleColor falls back to the design's accent so a design still looks like
    // itself when the desk does not pick a colour.
    titleColor: hex(campaign.titleColor) || hex(campaign.accentColor) || hex(d.accentColor),
    titleSize: size(campaign.titleSize),
    titleBold: campaign.titleBold !== false,
    bodyColor: hex(campaign.messageColor),
  };
  if (buttons.length) nx.buttons = buttons;
  if ((campaign.chips || []).length) nx.chips = campaign.chips.slice(0, 6).map((c) => str(c, 24));
  if (campaign.launchUrl) nx.url = str(campaign.launchUrl, 400);
  if (types.isRoute(campaign.route)) nx.route = String(campaign.route).trim();
  if (campaign.newsId) nx.newsId = String(campaign.newsId);
  const spots = cleanHotspots(campaign);
  if (spots.length) nx.spots = spots;
  if (Number(campaign.expireHours) > 0) nx.expireHours = Number(campaign.expireHours);
  if (campaign.ongoing === true) nx.ongoing = true;
  if (types.isPoll(campaign.type)) {
    nx.poll = {
      counts: opts.pollCounts || {},
      total: Number(opts.totalVotes) || 0,
    };
    // The phone records the vote itself (Android does it from the notification,
    // without opening the app), so it needs the endpoint. Sending it in the
    // payload keeps the URL in ONE place — the server that owns it — instead of
    // duplicating the API host inside the Android code.
    const base = String(opts.baseUrl || '').trim().replace(/\/+$/, '');
    if (base) nx.voteUrl = `${base}/api/public/notification/vote`;
  }
  if (campaign.type === 'progress') {
    const p = campaign.progress || {};
    nx.progress = {
      current: Number.isFinite(Number(p.current)) ? Number(p.current) : null,
      total: Number.isFinite(Number(p.total)) ? Number(p.total) : null,
      label: str(p.label, 80),
    };
  }

  // Native OneSignal fields — the fallback for app builds that do not know `nx`,
  // and what iOS uses today (it has no custom renderer).
  const native = {};
  if (nx.image && ['image', 'big_image', 'video'].includes(campaign.type)) {
    native.big_picture = nx.image;
    native.ios_attachments = { id1: nx.image };
  }
  if (buttons.length) {
    native.buttons = buttons.map((b) => ({ id: b.id, text: b.label }));
  }
  if (urgent) {
    native.priority = 10;
    native.android_visibility = 1;
  }
  if (silent) {
    native.priority = 5;
    native.android_sound = 'null';
    native.ios_sound = 'nil';
  }
  const accent = nx.accent;
  if (accent) native.android_accent_color = `FF${accent.replace('#', '')}`;

  return { data: nx, native };
}

module.exports = { build, cleanButtons, cleanHotspots, dedupeKey };
