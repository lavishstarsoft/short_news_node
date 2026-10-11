'use strict';

/**
 * The 18 notification designs, in one place.
 *
 * The admin page builds its picker from this list, the sender validates against
 * it, and the app renders by the same `type` string. Adding a design means
 * adding one entry here — nothing else has a hard-coded list.
 *
 * `needs` tells the admin form which fields to show; `defaults` pre-fills them.
 * `android` / `ios` say honestly how much of the design each platform can draw.
 */
const TYPES = [
  { key: 'simple', n: 1, label: 'Simple text', help: 'Plain headline + one line. Works everywhere.',
    needs: [], android: 'full', ios: 'full' },

  { key: 'image', n: 2, label: 'Rich (small image)', help: 'Thumbnail on the right of the text.',
    needs: ['imageUrl'], android: 'full', ios: 'full' },

  { key: 'big_image', n: 3, label: 'Big image', help: 'Full-width picture — best for breaking news.',
    needs: ['imageUrl'], android: 'full', ios: 'full' },

  { key: 'actions', n: 4, label: 'Two buttons', help: 'Ask something and give two buttons.',
    needs: ['buttons2'], android: 'full', ios: 'buttons-only',
    defaults: { buttons: [
      { id: 'yes', label: 'Yes', color: '#16A34A', action: 'open' },
      { id: 'no', label: 'No', color: '#DC2626', action: 'dismiss' },
    ] } },

  { key: 'poll_yes_no', n: 5, label: 'Poll — Yes / No', help: 'Two options, votes are counted and shown.',
    needs: ['buttons2'], poll: true, android: 'full', ios: 'buttons-only',
    defaults: { buttons: [
      { id: 'yes', label: 'Support', color: '#16A34A', action: 'vote' },
      { id: 'no', label: 'Oppose', color: '#DC2626', action: 'vote' },
    ] } },

  { key: 'poll_choice', n: 6, label: 'Poll — multiple choice', help: 'Up to 4 options, votes are counted.',
    needs: ['buttons4'], poll: true, android: 'full', ios: 'none',
    defaults: { buttons: [
      { id: 'opt_0', label: 'Option 1', action: 'vote' },
      { id: 'opt_1', label: 'Option 2', action: 'vote' },
    ] } },

  { key: 'categories', n: 7, label: 'Category chips', help: 'Show category chips the reader can tap.',
    needs: ['chips'], android: 'full', ios: 'none' },

  { key: 'progress', n: 8, label: 'Live score / progress', help: 'A progress bar that you update by sending again.',
    needs: ['progress'], android: 'full', ios: 'none', defaults: { emoji: '\u{1F3CF}' } },

  { key: 'links', n: 9, label: 'Link buttons', help: 'Two buttons that open a page in the app.',
    needs: ['buttons2'], android: 'full', ios: 'buttons-only',
    defaults: { buttons: [
      { id: 'open', label: 'Open', color: '#1D4ED8', action: 'link' },
      { id: 'more', label: 'Know more', action: 'link' },
    ] } },

  { key: 'promo', n: 10, label: 'Promotion / offer', help: 'Warm colour, gift icon — earnings and offers.',
    needs: [], android: 'full', ios: 'full', defaults: { accentColor: '#F59E0B', emoji: '\u{1F381}' } },

  { key: 'reminder', n: 11, label: 'Event / reminder', help: 'An event with a "remind me" button.',
    needs: ['buttons1'], android: 'full', ios: 'buttons-only',
    defaults: { emoji: '\u{1F4C5}', buttons: [{ id: 'remind', label: 'Set reminder', color: '#DC2626', action: 'remind' }] } },

  { key: 'location', n: 12, label: 'Location based', help: "News for the reader's own district.",
    needs: [], android: 'full', ios: 'full', defaults: { emoji: '\u{1F4CD}' } },

  { key: 'video', n: 13, label: 'Video', help: 'Thumbnail with a play badge. The video plays in the app, not in the notification.',
    needs: ['imageUrl'], android: 'full', ios: 'full' },

  { key: 'update', n: 14, label: 'App update', help: 'Tells the reader a new version is out.',
    needs: ['buttons1'], android: 'full', ios: 'buttons-only',
    defaults: { emoji: '\u{2B07}', buttons: [{ id: 'update', label: 'Update', color: '#1D4ED8', action: 'link' }] } },

  { key: 'achievement', n: 15, label: 'Achievement', help: 'Congratulate a reader (streaks, rewards).',
    needs: [], android: 'full', ios: 'full', defaults: { accentColor: '#16A34A', emoji: '\u{1F3C6}' } },

  { key: 'urgent', n: 16, label: 'Urgent alert', help: 'Red, high priority, pops over other apps.',
    needs: [], urgent: true, android: 'full', ios: 'full', defaults: { accentColor: '#DC2626', emoji: '\u{1F4E2}' } },

  { key: 'silent', n: 17, label: 'Silent', help: 'No sound, no vibration — sits quietly in the tray.',
    needs: [], silent: true, android: 'full', ios: 'full', defaults: { emoji: '\u{1F514}' } },

  { key: 'birthday', n: 18, label: 'Birthday / greeting', help: "A warm wish. Needs the reader's birthday to be known.",
    needs: [], android: 'full', ios: 'full', defaults: { accentColor: '#A855F7', emoji: '\u{1F382}' } },

  // Not on the printed design chart — added later, on request.
  { key: 'image_only', n: 19, label: 'Picture only', help: 'The picture IS the message — shown whole, nothing cropped, no title needed. Draw tappable areas on it.',
    needs: ['imageUrl', 'hotspots'], noTitle: true, android: 'full', ios: 'full' },
];

/**
 * Places inside the app a notification can open ("Tap opens").
 *
 * Every one of these is a screen that really exists and is really reachable —
 * a key the app does not know would make the tap do nothing. Keep in step with
 * `_studioRoutes` in App/lib/services/notification_service.dart.
 *
 * There is deliberately no "Polls" entry: polls are cards inside the news feed
 * (PollCard is only used by home_screen.dart), not a page of their own.
 */
const APP_ROUTES = [
  { key: 'home', label: '🏠 Home — news feed' },
  { key: 'train', label: '🚆 Track my Train' },
  { key: 'quiz', label: '🧠 Daily Quiz' },
  { key: 'viral', label: '🎬 Viral Videos' },
  { key: 'videos', label: '📺 Long Videos' },
  { key: 'games', label: '🎮 Games' },
  { key: 'bookmarks', label: '🔖 Bookmarks' },
  { key: 'refer', label: '🎁 Refer &amp; Earn' },
  { key: 'reporter_stories', label: '📰 Reporter — My Stories' },
];
const ROUTE_KEYS = APP_ROUTES.map((r) => r.key);
const isRoute = (key) => ROUTE_KEYS.includes(String(key || '').trim());

const BY_KEY = new Map(TYPES.map((t) => [t.key, t]));

const get = (key) => BY_KEY.get(String(key || '').trim()) || null;
const isPoll = (key) => !!(get(key) && get(key).poll);
/** Designs where the picture carries the message, so a headline is pointless. */
const needsTitle = (key) => !(get(key) && get(key).noTitle);

/** How many buttons this design allows (0 when it takes none). */
function maxButtons(key) {
  const t = get(key);
  if (!t) return 0;
  if (t.needs.includes('buttons4')) return 4;
  if (t.needs.includes('buttons2')) return 2;
  if (t.needs.includes('buttons1')) return 1;
  return 0;
}

module.exports = {
  TYPES, get, isPoll, maxButtons, KEYS: TYPES.map((t) => t.key),
  APP_ROUTES, ROUTE_KEYS, isRoute, needsTitle,
};
