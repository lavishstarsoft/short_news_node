'use strict';

/**
 * Notification Studio — the 18 designs, who a notification reaches, what actually
 * goes to OneSignal, and real poll counting.
 *
 * The rules worth protecting on a live app:
 *  • a named audience with an empty list must NEVER become "everyone";
 *  • a test send goes to exactly one phone;
 *  • a campaign is marked 'sent' only after OneSignal accepts it;
 *  • one phone = one vote, and voting again replaces the old answer.
 */

jest.mock('../models/Admin', () => ({ distinct: jest.fn(), find: jest.fn() }));
jest.mock('../models/User', () => ({ countDocuments: jest.fn(() => Promise.resolve(0)), find: jest.fn() }));
jest.mock('../models/NotificationCampaign', () => ({
  findById: jest.fn(), updateOne: jest.fn(() => Promise.resolve({})), create: jest.fn(), find: jest.fn(),
}));
jest.mock('../models/NotificationVote', () => ({ aggregate: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/oneSignalService', () => ({ client: { createNotification: jest.fn() }, appId: 'app-123' }));

const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const User = require('../models/User');
const NotificationCampaign = require('../models/NotificationCampaign');
const NotificationVote = require('../models/NotificationVote');
const oneSignal = require('../services/oneSignalService');

const types = require('../services/notifications/notificationTypes');
const audience = require('../services/notifications/audience');
const { build } = require('../services/notifications/payloadBuilder');
const sender = require('../services/notifications/campaignSender');

const oid = () => new mongoose.Types.ObjectId();

beforeEach(() => {
  jest.clearAllMocks();
  oneSignal.client.createNotification.mockResolvedValue({ id: 'os-1', recipients: 7 });
  NotificationVote.aggregate.mockResolvedValue([]);
});

// ── the design registry ──────────────────────────────────────────────────────
describe('the 18 designs', () => {
  test('the 18 from the design chart, plus the picture-only one added later', () => {
    expect(types.TYPES).toHaveLength(19);
    expect(types.TYPES.map((t) => t.n)).toEqual([...Array(19)].map((_, i) => i + 1));
    expect(new Set(types.KEYS).size).toBe(19);
    expect(types.TYPES[18].key).toBe('image_only');
  });

  test('every design says honestly what Android and iPhone can draw', () => {
    for (const t of types.TYPES) {
      expect(['full', 'buttons-only', 'none']).toContain(t.android);
      expect(['full', 'buttons-only', 'none']).toContain(t.ios);
      expect(t.label && t.help).toBeTruthy();
    }
  });

  test('the database accepts every design the picker offers', () => {
    // A second hand-written list in the model once left `image_only` out, so the
    // picker offered a design that Mongoose then refused: "not a valid enum
    // value for path `type`". The model derives its list now; this proves it.
    const Campaign = jest.requireActual('../models/NotificationCampaign');
    expect(Campaign.NOTIFICATION_TYPES).toEqual(types.KEYS);
    for (const key of types.KEYS) {
      expect(Campaign.NOTIFICATION_TYPES).toContain(key);
    }
  });

  test('only the picture design may go without a headline', () => {
    expect(types.needsTitle('image_only')).toBe(false);
    for (const key of types.KEYS.filter((k) => k !== 'image_only')) {
      expect(types.needsTitle(key)).toBe(true);
    }
  });

  test('a picture with no words still gets a heading OneSignal will accept', async () => {
    await sender.send({
      _id: oid(), type: 'image_only', title: '', imageUrl: 'https://x/a.jpg',
      audience: { kind: 'all' }, buttons: [],
    });
    const sent = oneSignal.client.createNotification.mock.calls[0][0];
    expect(sent.headings.en).toBe('Tehelka News');   // blank headings are refused
    expect(sent.data.nx.title).toBe('');             // the card itself shows none
  });

  test('the dashboard preview knows how to draw every design', () => {
    // The page keeps its own LOOKS table (card colour, left icon, chevron…).
    // A design missing from it would silently preview as a plain card while the
    // phone drew something else.
    const page = require('fs').readFileSync(require('path').join(__dirname, '..', 'views', 'notification-studio.ejs'), 'utf8');
    const table = page.slice(page.indexOf('const LOOKS = {'), page.indexOf('const CHIP_TINTS'));
    for (const key of types.KEYS) {
      expect(table).toContain(`${key}:`);
    }
  });

  test('every design that shows a big left icon carries an emoji to put there', () => {
    // StudioNotifications draws these with the emoji as the icon instead of
    // inside the title — without one the slot would be empty.
    for (const key of ['progress', 'reminder', 'location', 'update', 'achievement', 'silent', 'birthday', 'promo']) {
      const d = types.get(key);
      expect(d.defaults && d.defaults.emoji).toBeTruthy();
    }
  });

  test('the "tap opens" list only names pages the app really has', () => {
    // NotificationService.studioRoutes in the app must hold exactly these keys;
    // App/test/studio_notification_test.dart asserts the other side.
    expect(types.ROUTE_KEYS).toEqual([
      'home', 'train', 'quiz', 'viral', 'videos', 'games', 'bookmarks', 'refer',
      'reporter_stories',
    ]);
    // There is no standalone Polls page — polls are cards in the news feed.
    expect(types.isRoute('polls')).toBe(false);
    expect(types.isRoute('')).toBe(false);
    expect(types.APP_ROUTES.every((r) => r.key && r.label)).toBe(true);
  });

  test('only the two poll designs count votes', () => {
    expect(types.KEYS.filter((k) => types.isPoll(k))).toEqual(['poll_yes_no', 'poll_choice']);
  });

  test('button limits match each design', () => {
    expect(types.maxButtons('simple')).toBe(0);
    expect(types.maxButtons('actions')).toBe(2);
    expect(types.maxButtons('poll_choice')).toBe(4);
    expect(types.maxButtons('reminder')).toBe(1);
    expect(types.maxButtons('nonsense')).toBe(0);
  });
});

// ── who gets it ──────────────────────────────────────────────────────────────
describe('audience', () => {
  test('everyone → the subscribed segment', async () => {
    const t = await audience.resolve({ kind: 'all' });
    expect(t.targeting).toEqual({ included_segments: ['Subscribed Users'] });
  });

  test('a district becomes a tag filter with the same normalising the app uses', async () => {
    const t = await audience.resolve({ kind: 'district', district: 'Krishna District' });
    expect(t.targeting.filters[0]).toEqual({ field: 'tag', key: 'user_district', relation: '=', value: 'krishna_district' });
  });

  test('a reporter is the BARE id the live app already registers', async () => {
    // Changing this format would silently stop reporter pushes on every phone that
    // has not updated the app — ReporterPushService.bindReporter and
    // services/reporterNotifier.js both use the bare Admin _id.
    const id = oid();
    const r = await audience.resolve({ kind: 'reporter_list', reporterIds: [id] });
    expect(r.targeting.include_aliases.external_id).toEqual([String(id)]);
  });

  test("a reader is reached by their Google id, which is what the app registers", async () => {
    const id = oid();
    User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: id, googleId: 'g-123', displayName: 'Sita' }]) }) });
    const u = await audience.resolve({ kind: 'user_list', userIds: [id] });
    expect(u.targeting.include_aliases.external_id).toEqual(['u:g-123']);
    expect(u.describe).toBe('1 app user');
  });

  test('readers with no Google sign-in are reported, not silently dropped', async () => {
    const [a, b] = [oid(), oid()];
    User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: a, googleId: 'g-1' }, { _id: b, googleId: null }]) }) });
    const u = await audience.resolve({ kind: 'user_list', userIds: [a, b] });
    expect(u.estimate).toBe(1);
    expect(u.describe).toMatch(/1 skipped/);

    User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: a, googleId: '' }]) }) });
    await expect(audience.resolve({ kind: 'user_list', userIds: [a] }))
      .rejects.toMatchObject({ code: 'EMPTY_AUDIENCE' });
  });

  test('all reporters = the active ones only', async () => {
    const ids = [oid(), oid()];
    Admin.distinct.mockResolvedValue(ids);
    const t = await audience.resolve({ kind: 'reporters' });
    expect(Admin.distinct).toHaveBeenCalledWith('_id', { role: { $in: ['editor', 'subeditor'] }, isActive: { $ne: false } });
    expect(t.targeting.include_aliases.external_id).toEqual(ids.map(String));
    expect(t.estimate).toBe(2);
  });

  test('EVERY alias audience carries target_channel — OneSignal rejects the send without it', async () => {
    // Live failure 2026-09-26: "target_channel must be specified when using
    // targeting by alias". include_aliases and target_channel must never be
    // separated; services/reporterNotifier.js has always sent both.
    const id = oid();
    Admin.distinct.mockResolvedValue([id]);
    User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: id, googleId: 'g-1' }]) }) });

    for (const a of [
      { kind: 'reporters' },
      { kind: 'reporter_list', reporterIds: [id] },
      { kind: 'user_list', userIds: [id] },
    ]) {
      const t = await audience.resolve(a);
      expect(t.targeting.include_aliases).toBeDefined();
      expect(t.targeting.target_channel).toBe('push');
    }
    expect(audience.byAlias(['x']).target_channel).toBe('push');
  });

  test('segment and tag audiences do NOT carry target_channel (it is alias-only)', async () => {
    for (const a of [{ kind: 'all' }, { kind: 'language', language: 'te' }, { kind: 'district', district: 'Krishna' }]) {
      const t = await audience.resolve(a);
      expect(t.targeting.target_channel).toBeUndefined();
      expect(t.targeting.include_aliases).toBeUndefined();
    }
  });

  test('an empty or unknown audience REFUSES — it never falls through to everyone', async () => {
    const cases = [
      { kind: 'reporter_list', reporterIds: [] },
      { kind: 'user_list', userIds: [] },
      { kind: 'district', district: '' },
      { kind: 'state', state: '   ' },
      { kind: 'language', language: '' },
      { kind: 'made_up' },
    ];
    for (const a of cases) {
      await expect(audience.resolve(a)).rejects.toMatchObject({ code: 'EMPTY_AUDIENCE', status: 400 });
    }
    Admin.distinct.mockResolvedValue([]);
    await expect(audience.resolve({ kind: 'reporters' })).rejects.toMatchObject({ code: 'EMPTY_AUDIENCE' });
  });
});

// ── what the phone receives ──────────────────────────────────────────────────
describe('payload', () => {
  test('a big image travels in nx AND in the native field, so old app builds still show it', () => {
    const { data, native } = build({ _id: 'c1', type: 'big_image', title: 'T', message: 'M', imageUrl: 'https://x/i.jpg' });
    expect(data.type).toBe('big_image');
    expect(data.image).toBe('https://x/i.jpg');
    expect(native.big_picture).toBe('https://x/i.jpg');
  });

  test('a design keeps its own look when the desk leaves the colour blank, and yields when it does not', () => {
    expect(build({ _id: 'c', type: 'urgent', title: 'T' }).data.accent).toBe('#DC2626');
    expect(build({ _id: 'c', type: 'urgent', title: 'T', accentColor: '#123456' }).data.accent).toBe('#123456');
    expect(build({ _id: 'c', type: 'urgent', title: 'T', accentColor: 'red' }).data.accent).toBe('#DC2626'); // junk ignored
  });

  test('urgent asks for top priority; silent asks for no sound', () => {
    expect(build({ _id: 'c', type: 'urgent', title: 'T' }).native.priority).toBe(10);
    const s = build({ _id: 'c', type: 'silent', title: 'T' }).native;
    expect(s.android_sound).toBe('null');
    expect(s.priority).toBe(5);
  });

  test('extra buttons beyond the design limit are dropped, not sent', () => {
    const many = [1, 2, 3, 4, 5, 6].map((i) => ({ id: `b${i}`, label: `B${i}` }));
    expect(build({ _id: 'c', type: 'actions', title: 'T', buttons: many }).data.buttons).toHaveLength(2);
    expect(build({ _id: 'c', type: 'poll_choice', title: 'T', buttons: many }).data.buttons).toHaveLength(4);
    expect(build({ _id: 'c', type: 'simple', title: 'T', buttons: many }).data.buttons).toBeUndefined();
  });

  test('Telugu text is preserved exactly', () => {
    const d = build({ _id: 'c', type: 'simple', title: 'విజయవాడలో భారీ వర్షం', message: 'జాగ్రత్తగా ఉండండి' }).data;
    expect(d.title).toBe('విజయవాడలో భారీ వర్షం');
    expect(d.body).toBe('జాగ్రత్తగా ఉండండి');
  });

  test('a poll carries its running counts; a non-poll carries none', () => {
    expect(build({ _id: 'c', type: 'poll_yes_no', title: 'T' }, { pollCounts: { yes: 3 }, totalVotes: 3 }).data.poll)
      .toEqual({ counts: { yes: 3 }, total: 3 });
    expect(build({ _id: 'c', type: 'simple', title: 'T' }).data.poll).toBeUndefined();
  });

  test('a poll carries the vote endpoint, so the phone never hard-codes the API host', () => {
    const withBase = build({ _id: 'c', type: 'poll_yes_no', title: 'T' }, { baseUrl: 'https://news.example.in/' });
    expect(withBase.data.voteUrl).toBe('https://news.example.in/api/public/notification/vote');
    // no base configured → no half-built URL is sent
    expect(build({ _id: 'c', type: 'poll_yes_no', title: 'T' }).data.voteUrl).toBeUndefined();
    // and a non-poll never gets one
    expect(build({ _id: 'c', type: 'simple', title: 'T' }, { baseUrl: 'https://news.example.in' }).data.voteUrl).toBeUndefined();
  });

  test('title styling travels: colour, size, bold, message colour', () => {
    const d = build({
      _id: 'c', type: 'simple', title: 'T',
      titleColor: '#FF0000', messageColor: '#222222', titleSize: 'large', titleBold: false,
    }).data;
    expect(d.titleColor).toBe('#FF0000');
    expect(d.bodyColor).toBe('#222222');
    expect(d.titleSize).toBe('large');
    expect(d.titleBold).toBe(false);
  });

  test('a design colours its own title when the desk picks nothing', () => {
    expect(build({ _id: 'c', type: 'urgent', title: 'T' }).data.titleColor).toBe('#DC2626');
    expect(build({ _id: 'c', type: 'promo', title: 'T' }).data.titleColor).toBe('#F59E0B');
  });

  test('a junk size or colour falls back instead of reaching the phone', () => {
    const d = build({ _id: 'c', type: 'simple', title: 'T', titleSize: 'gigantic', titleColor: 'red' }).data;
    expect(d.titleSize).toBe('normal');
    expect(d.titleColor).toBe('');       // 'red' is not #RRGGBB, and simple has no default
    expect(d.titleBold).toBe(true);      // bold unless explicitly turned off
  });

  test('the styling also goes in the keys the CURRENT app build already reads', async () => {
    // NotificationServiceExtension.kt on phones today reads titleColor /
    // messageColor / titleFontSize at the top level — so a coloured, bigger
    // title works before anyone updates the app.
    await sender.send({
      _id: oid(), type: 'simple', title: 'T', audience: { kind: 'all' }, buttons: [],
      titleColor: '#FF0000', messageColor: '#222222', titleSize: 'xlarge',
    });
    const sent = oneSignal.client.createNotification.mock.calls[0][0];
    expect(sent.data.titleColor).toBe('#FF0000');
    expect(sent.data.messageColor).toBe('#222222');
    expect(sent.data.titleFontSize).toBe('large'); // that build knows small|normal|large only
  });

  test('identical content gets the SAME dedupe key, different content does not', () => {
    // The phone uses this as the Android notification id, so sending the same
    // thing twice replaces the first instead of showing two.
    const base = { _id: 'a', type: 'image', title: 'వరద హెచ్చరిక', message: 'జాగ్రత్త', audience: { kind: 'all' } };
    const again = { ...base, _id: 'b' };                       // a second send of the same thing
    expect(build(again).data.dedupe).toBe(build(base).data.dedupe);

    // …and anything the reader would actually see as different keeps its own slot
    expect(build({ ...base, title: 'వేరే వార్త' }).data.dedupe).not.toBe(build(base).data.dedupe);
    expect(build({ ...base, message: 'వేరే వివరాలు' }).data.dedupe).not.toBe(build(base).data.dedupe);
    expect(build({ ...base, type: 'big_image' }).data.dedupe).not.toBe(build(base).data.dedupe);
    expect(build({ ...base, audience: { kind: 'reporters' } }).data.dedupe).not.toBe(build(base).data.dedupe);
  });

  test('the dedupe key also becomes the OneSignal collapse id', async () => {
    const c = { _id: oid(), type: 'simple', title: 'T', message: 'M', audience: { kind: 'all' }, buttons: [] };
    await sender.send(c);
    const sent = oneSignal.client.createNotification.mock.calls[0][0];
    expect(sent.collapse_id).toBe(sent.data.nx.dedupe);
    expect(sent.collapse_id).toBeTruthy();
  });

  test('tappable areas: kept when they can do something, dropped when they cannot', () => {
    const d = build({
      _id: 'c', type: 'image_only', title: 'T', imageUrl: 'https://x/a.jpg',
      hotspots: [
        { x: 0, y: 0.66, w: 0.5, h: 0.34, action: 'vote', value: 'yes' },
        { x: 0.5, y: 0.66, w: 0.5, h: 0.34, action: 'vote', value: 'no' },
        { x: 0.1, y: 0.1, w: 0.001, h: 0.001, action: 'open' },   // too small to hit
        { x: 0.2, y: 0.2, w: 0.3, h: 0.2, action: 'link', value: '' }, // link to nowhere
        { x: 0.2, y: 0.2, w: 0.3, h: 0.2, action: 'made_up', value: 'x' },
      ],
    }).data;
    expect(d.spots.map((s) => s.value)).toEqual(['yes', 'no', 'x']);
    expect(d.spots[2].action).toBe('open');   // unknown action becomes a plain tap
  });

  test('area coordinates are clamped, so one can never point off the picture', () => {
    const d = build({
      _id: 'c', type: 'image_only', title: 'T',
      hotspots: [{ x: -3, y: 9, w: 5, h: 0.5, action: 'open' }],
    }).data;
    expect(d.spots[0]).toMatchObject({ x: 0, y: 1, w: 1 });
  });

  test('no more than 12 areas — that is every cell of the grid the phone can hit', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ x: 0, y: 0, w: 0.2, h: 0.2, action: 'open', value: String(i) }));
    expect(build({ _id: 'c', type: 'image_only', title: 'T', hotspots: many }).data.spots).toHaveLength(12);
  });

  test('auto-expire and stay-on-top only travel when asked for', () => {
    const on = build({ _id: 'c', type: 'progress', title: 'T', expireHours: 6, ongoing: true }).data;
    expect(on.expireHours).toBe(6);
    expect(on.ongoing).toBe(true);
    const off = build({ _id: 'c', type: 'simple', title: 'T' }).data;
    expect(off.expireHours).toBeUndefined();
    expect(off.ongoing).toBeUndefined();
  });

  test('an unknown design is refused rather than sent as something broken', () => {
    expect(() => build({ _id: 'c', type: 'hologram', title: 'T' })).toThrow(/Unknown notification type/);
  });
});

// ── sending ──────────────────────────────────────────────────────────────────
describe('sending', () => {
  const campaign = (over = {}) => ({
    _id: oid(), type: 'simple', title: 'Hello', message: 'World',
    audience: { kind: 'all' }, buttons: [], ...over,
  });

  test('the notification carries the app payload plus the legacy type, and the targeting', async () => {
    const c = campaign();
    const out = await sender.send(c);
    const sent = oneSignal.client.createNotification.mock.calls[0][0];
    expect(sent.app_id).toBe('app-123');
    expect(sent.headings.en).toBe('Hello');
    expect(sent.data.type).toBe('admin');           // old builds keep working
    expect(sent.data.nx.type).toBe('simple');       // new builds draw the design
    expect(sent.data.campaignId).toBe(String(c._id));
    expect(sent.included_segments).toEqual(['Subscribed Users']);
    expect(out.recipients).toBe(7);
  });

  test("marked 'sent' only after OneSignal accepts — and 'failed' with the reason when it does not", async () => {
    await sender.send(campaign());
    expect(NotificationCampaign.updateOne.mock.calls[0][1].$set).toMatchObject({ status: 'sent', oneSignalId: 'os-1', recipientsEstimate: 7 });

    NotificationCampaign.updateOne.mockClear();
    oneSignal.client.createNotification.mockRejectedValue({ body: { errors: ['bad app_id'] } });
    await expect(sender.send(campaign())).rejects.toMatchObject({ status: 502 });
    expect(NotificationCampaign.updateOne.mock.calls[0][1].$set.status).toBe('failed');
    expect(NotificationCampaign.updateOne.mock.calls[0][1].$set.error).toContain('bad app_id');
  });

  test('a rejection explains the likely cause without hiding the real error', async () => {
    oneSignal.client.createNotification.mockRejectedValue({ body: { errors: ['invalid_aliases'] } });
    await expect(sender.send(campaign())).rejects.toThrow(/invalid_aliases.*no phone registered yet/s);

    oneSignal.client.createNotification.mockRejectedValue({ body: { errors: ['All included players are not subscribed'] } });
    await expect(sender.send(campaign())).rejects.toThrow(/not subscribed.*notifications switched on/s);

    // an error we have no hint for is passed through untouched
    oneSignal.client.createNotification.mockRejectedValue({ body: { errors: ['something new'] } });
    await expect(sender.send(campaign())).rejects.toThrow(/something new/);
  });

  test('a test send goes to exactly one alias and does NOT mark the campaign sent', async () => {
    const out = await sender.send(campaign(), { testAlias: 'r:abc' });
    const sent = oneSignal.client.createNotification.mock.calls[0][0];
    expect(sent.include_aliases).toEqual({ external_id: ['r:abc'] });
    expect(sent.target_channel).toBe('push'); // without this OneSignal refuses the send
    expect(sent.included_segments).toBeUndefined();
    expect(NotificationCampaign.updateOne).not.toHaveBeenCalled();
    expect(out.test).toBe(true);
  });

  test('a test send ignores the saved audience — it can never leak to everyone', async () => {
    await sender.send(campaign({ audience: { kind: 'all' } }), { testAlias: 'u:xyz' });
    const sent = oneSignal.client.createNotification.mock.calls[0][0];
    expect(sent.included_segments).toBeUndefined();
    expect(sent.include_aliases.external_id).toEqual(['u:xyz']);
  });

  test('an empty named audience stops the send before OneSignal is called at all', async () => {
    await expect(sender.send(campaign({ audience: { kind: 'reporter_list', reporterIds: [] } })))
      .rejects.toMatchObject({ code: 'EMPTY_AUDIENCE' });
    expect(oneSignal.client.createNotification).not.toHaveBeenCalled();
  });

  test('a language send carries `language`, so app builds older than the Studio show it too', async () => {
    await sender.send(campaign({ audience: { kind: 'language', language: 'TE' } }));
    expect(oneSignal.client.createNotification.mock.calls[0][0].data.language).toBe('te');
  });

  test('other audiences carry no `language` — it would be a lie about who it is for', async () => {
    for (const a of [{ kind: 'all' }, { kind: 'district', district: 'Krishna' }]) {
      oneSignal.client.createNotification.mockClear();
      await sender.send(campaign({ audience: a }));
      expect(oneSignal.client.createNotification.mock.calls[0][0].data.language).toBeUndefined();
    }
  });

  test('a news id and a link sit where older builds look for them, so a tap still works', async () => {
    const news = oid();
    await sender.send(campaign({ newsId: news, launchUrl: 'https://tehelkanews.in/x' }));
    const sent = oneSignal.client.createNotification.mock.calls[0][0];
    expect(sent.data.newsId).toBe(String(news));
    expect(sent.data.launchUrl).toBe('https://tehelkanews.in/x');
  });

  test('an empty message still sends (a title-only notification is legitimate)', async () => {
    await sender.send(campaign({ message: '' }));
    expect(oneSignal.client.createNotification.mock.calls[0][0].contents.en).toBeTruthy();
  });
});

// ── real poll counting ───────────────────────────────────────────────────────
describe('poll votes are really counted', () => {
  const pollCampaign = (id) => ({
    _id: id, type: 'poll_yes_no', title: 'Do you support it?',
    buttons: [{ id: 'yes', label: 'Support' }, { id: 'no', label: 'Oppose' }],
  });

  test('a vote is stored per device and the campaign totals are updated', async () => {
    const id = oid();
    NotificationCampaign.findById.mockReturnValue({ lean: () => Promise.resolve(pollCampaign(id)) });
    NotificationVote.findOneAndUpdate.mockResolvedValue({ lastErrorObject: { upserted: 'v1' } });
    NotificationVote.aggregate.mockResolvedValue([{ _id: 'yes', n: 2 }, { _id: 'no', n: 1 }]);

    const out = await sender.vote({ campaignId: id, voterKey: 'device-1', optionId: 'yes' });

    expect(NotificationVote.findOneAndUpdate.mock.calls[0][0]).toEqual({ campaignId: id, voterKey: 'device-1' });
    expect(NotificationVote.findOneAndUpdate.mock.calls[0][2]).toMatchObject({ upsert: true });
    expect(out.counts).toEqual({ yes: 2, no: 1 });
    expect(out.total).toBe(3);
    expect(out.changed).toBe(false);                       // this was a first vote
    expect(NotificationCampaign.updateOne.mock.calls[0][1].$set['poll.totalVotes']).toBe(3);
  });

  test('voting again changes the answer instead of adding a second vote', async () => {
    const id = oid();
    NotificationCampaign.findById.mockReturnValue({ lean: () => Promise.resolve(pollCampaign(id)) });
    NotificationVote.findOneAndUpdate.mockResolvedValue({ lastErrorObject: {} }); // matched an existing vote
    NotificationVote.aggregate.mockResolvedValue([{ _id: 'no', n: 1 }]);

    const out = await sender.vote({ campaignId: id, voterKey: 'device-1', optionId: 'no' });
    expect(out.changed).toBe(true);
    expect(out.total).toBe(1);                             // still one vote from that phone
  });

  test('an option that is not on the notification is refused', async () => {
    const id = oid();
    NotificationCampaign.findById.mockReturnValue({ lean: () => Promise.resolve(pollCampaign(id)) });
    await expect(sender.vote({ campaignId: id, voterKey: 'd', optionId: 'maybe' })).rejects.toMatchObject({ status: 400 });
    expect(NotificationVote.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('voting on a non-poll notification, or a deleted one, is refused', async () => {
    const id = oid();
    NotificationCampaign.findById.mockReturnValue({ lean: () => Promise.resolve({ _id: id, type: 'simple', buttons: [] }) });
    await expect(sender.vote({ campaignId: id, voterKey: 'd', optionId: 'yes' })).rejects.toMatchObject({ status: 400 });

    NotificationCampaign.findById.mockReturnValue({ lean: () => Promise.resolve(null) });
    await expect(sender.vote({ campaignId: id, voterKey: 'd', optionId: 'yes' })).rejects.toMatchObject({ status: 404 });
  });
});
