const mongoose = require('mongoose');

/**
 * One notification the desk sent (or scheduled) from /admin/notification-studio.
 *
 * Kept separate from the old `Notification` model so the existing "Send
 * Notification" page keeps working exactly as before — this is additive.
 *
 * `type` decides how the phone draws it (see NOTIFICATION_TYPES). Everything the
 * app needs to render and to act on a button tap is inside `payload`.
 */

/**
 * The designs the desk can choose from.
 *
 * DERIVED from the one real list in services/notifications/notificationTypes.js,
 * never copied. A second hand-written copy is how `image_only` came to be a
 * valid design everywhere except here, and every send of it failed validation.
 * That file requires nothing, so there is no import cycle.
 */
const NOTIFICATION_TYPES = require('../services/notifications/notificationTypes').KEYS;

/** Who it goes to. */
const AUDIENCE_KINDS = [
  'all',            // everyone
  'language',       // readers of one news language
  'state',          // readers in a state
  'district',       // readers in a district
  'reporters',      // every reporter
  'reporter_list',  // chosen reporters
  'user_list',      // chosen app users
];

const buttonSchema = new mongoose.Schema({
  id: { type: String, required: true },      // 'yes' | 'no' | 'opt_0' | 'open' …
  label: { type: String, required: true },
  color: { type: String, default: '' },      // #RRGGBB, used by the Android renderer
  icon: { type: String, default: '' },       // emoji or a small icon name
  action: { type: String, default: 'open' }, // open | vote | link | dismiss | remind
  url: { type: String, default: '' },        // for action 'link' / 'open'
}, { _id: false });

/**
 * A tappable rectangle drawn on the picture, stored 0..1 so it scales to any
 * screen — the same shape the train promo banner and Special Deck already use.
 *
 * The phone can only make a GRID of cells clickable (RemoteViews cannot place a
 * view at an arbitrary position before Android 12), so the editor snaps these to
 * the same 4x3 grid the app uses. What the desk draws is what a reader can tap.
 */
const hotspotSchema = new mongoose.Schema({
  x: { type: Number, default: 0, min: 0, max: 1 },
  y: { type: Number, default: 0, min: 0, max: 1 },
  w: { type: Number, default: 0, min: 0, max: 1 },
  h: { type: Number, default: 0, min: 0, max: 1 },
  action: { type: String, default: 'open' }, // open | link | route | vote
  value: { type: String, default: '' },      // url / route key / poll option id
  label: { type: String, default: '' },      // desk's own note, never shown
}, { _id: false });

const notificationCampaignSchema = new mongoose.Schema({
  type: { type: String, enum: NOTIFICATION_TYPES, required: true, index: true },
  // Not required: the 'Picture only' design has no headline at all.
  // The controller still demands one for every design that shows text.
  title: { type: String, default: '', trim: true },
  message: { type: String, default: '', trim: true },

  // Look. titleColor / messageColor / titleSize are the same three controls the
  // older "Send Notification" page has, and travel in the same payload fields,
  // so the app renders them the way it already does.
  imageUrl: { type: String, default: '' },
  thumbnailUrl: { type: String, default: '' },
  titleColor: { type: String, default: '' },
  messageColor: { type: String, default: '' },
  titleSize: { type: String, enum: ['small', 'normal', 'large', 'xlarge'], default: 'normal' },
  titleBold: { type: Boolean, default: true },
  accentColor: { type: String, default: '' },
  emoji: { type: String, default: '' },

  // Behaviour
  buttons: { type: [buttonSchema], default: [] },
  chips: { type: [String], default: [] },       // 'categories' type
  launchUrl: { type: String, default: '' },     // an EXTERNAL link a plain tap opens
  // A place inside the app a tap opens (train / quiz / viral …). See APP_ROUTES
  // in services/notifications/notificationTypes.js — an unknown key would make
  // the tap do nothing, so the controller only accepts ones the app knows.
  route: { type: String, default: '' },
  newsId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', default: null },
  silent: { type: Boolean, default: false },
  urgent: { type: Boolean, default: false },
  /** Tappable areas drawn on the picture ('Picture only' design). */
  hotspots: { type: [hotspotSchema], default: [] },
  /** Hours after which the phone removes it by itself (0 = stays). */
  expireHours: { type: Number, default: 0, min: 0, max: 168 },
  /** Keeps a live score at the top of the tray until it is sent again. */
  ongoing: { type: Boolean, default: false },

  // 'progress' type
  progress: {
    current: { type: Number, default: null },
    total: { type: Number, default: null },
    label: { type: String, default: '' },
  },

  // Audience
  audience: {
    kind: { type: String, enum: AUDIENCE_KINDS, default: 'all' },
    language: { type: String, default: '' },
    state: { type: String, default: '' },
    district: { type: String, default: '' },
    reporterIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Admin' }],
    userIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },

  // Poll tally — one counter per button id, plus who voted (so a person votes once).
  poll: {
    enabled: { type: Boolean, default: false },
    counts: { type: Map, of: Number, default: undefined },
    totalVotes: { type: Number, default: 0 },
  },

  // Result of the send
  status: { type: String, enum: ['draft', 'test', 'sent', 'failed'], default: 'draft', index: true },
  oneSignalId: { type: String, default: '' },
  recipientsEstimate: { type: Number, default: 0 },
  // Real delivered count from our own FCM token-multicast send (0 until token mode is on).
  fcmDelivered: { type: Number, default: 0 },
  error: { type: String, default: '' },

  sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  sentByName: { type: String, default: '' },
  sentAt: { type: Date, default: null },
}, { timestamps: true });

notificationCampaignSchema.index({ createdAt: -1 });
notificationCampaignSchema.index({ 'poll.enabled': 1, createdAt: -1 });

notificationCampaignSchema.statics.TYPES = NOTIFICATION_TYPES;
notificationCampaignSchema.statics.AUDIENCE_KINDS = AUDIENCE_KINDS;

module.exports = mongoose.model('NotificationCampaign', notificationCampaignSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
module.exports.AUDIENCE_KINDS = AUDIENCE_KINDS;
