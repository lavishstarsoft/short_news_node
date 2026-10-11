'use strict';

/**
 * Notification Studio endpoints: who may send, what gets rejected before anything
 * is saved or pushed, where a test send goes, and the app's poll-vote endpoint.
 */

jest.mock('../models/Admin', () => ({ find: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/User', () => ({ find: jest.fn(), countDocuments: jest.fn(() => Promise.resolve(0)) }));
jest.mock('../models/Location', () => ({ distinct: jest.fn(() => Promise.resolve([])) }));
jest.mock('../models/News', () => ({ find: jest.fn() }));
jest.mock('../models/NotificationCampaign', () => ({
  create: jest.fn(), find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), updateOne: jest.fn(),
}));
jest.mock('../services/notifications/campaignSender', () => ({ send: jest.fn(), vote: jest.fn(), tally: jest.fn() }));
jest.mock('../utils/auditLogger', () => ({ logAudit: jest.fn() }));

const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const User = require('../models/User');
const Location = require('../models/Location');
const NotificationCampaign = require('../models/NotificationCampaign');
const sender = require('../services/notifications/campaignSender');
const { logAudit } = require('../utils/auditLogger');
const ctrl = require('../controllers/notificationStudioController');

const oid = () => new mongoose.Types.ObjectId();

/** A res that records what the handler did. `status` returns itself, as Express does. */
function mockRes() {
  const res = { code: 200, body: null, rendered: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.render = (view, data) => { res.rendered = { view, data }; return res; };
  return res;
}
const asAdmin = (role = 'admin') => ({ id: String(oid()), username: 'desk', role });

beforeEach(() => {
  jest.clearAllMocks();
  NotificationCampaign.create.mockImplementation((doc) => Promise.resolve({ ...doc, _id: oid() }));
  // Default: nothing identical was sent recently, so the repeat guard lets it through.
  NotificationCampaign.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });
  sender.send.mockResolvedValue({ id: 'os-1', recipients: 5, describe: 'Everyone', test: false });
});

const sendReq = (body, role = 'admin') => ({ body, admin: asAdmin(role), headers: {} });

describe('permission', () => {
  test.each(['editor', 'subeditor', 'reporter'])('role %s cannot send', async (role) => {
    const res = mockRes();
    await ctrl.send(sendReq({ type: 'simple', title: 'T' }, role), res);
    expect(res.code).toBe(403);
    expect(sender.send).not.toHaveBeenCalled();
    expect(NotificationCampaign.create).not.toHaveBeenCalled();
  });

  test('a request with no role at all cannot send', async () => {
    const res = mockRes();
    await ctrl.send({ body: { type: 'simple', title: 'T' }, admin: {}, headers: {} }, res);
    expect(res.code).toBe(403);
    expect(sender.send).not.toHaveBeenCalled();
  });

  test.each(['admin', 'superadmin'])('role %s can send', async (role) => {
    const res = mockRes();
    await ctrl.send(sendReq({ type: 'simple', title: 'T', audience: { kind: 'all' } }, role), res);
    expect(res.code).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('what is rejected before anything is saved or pushed', () => {
  test('an unknown design', async () => {
    const res = mockRes();
    await ctrl.send(sendReq({ type: 'hologram', title: 'T' }), res);
    expect(res.code).toBe(400);
    expect(NotificationCampaign.create).not.toHaveBeenCalled();
  });

  test('the picture design is allowed a blank title, but needs a picture', async () => {
    const res1 = mockRes();
    await ctrl.send(sendReq({ type: 'image_only', title: '', imageUrl: 'https://x/a.jpg', audience: { kind: 'all' } }), res1);
    expect(res1.code).toBe(200);

    const res2 = mockRes();
    await ctrl.send(sendReq({ type: 'image_only', title: '', audience: { kind: 'all' } }), res2);
    expect(res2.code).toBe(400);
    expect(res2.body.error).toMatch(/needs a picture/i);
  });

  test('a blank title on a design that shows one', async () => {
    for (const title of ['', '   ', undefined]) {
      const res = mockRes();
      await ctrl.send(sendReq({ type: 'simple', title }), res);
      expect(res.code).toBe(400);
    }
    expect(NotificationCampaign.create).not.toHaveBeenCalled();
  });

  test('a named audience with nobody in it — no orphan draft is left behind', async () => {
    const res = mockRes();
    await ctrl.send(sendReq({ type: 'simple', title: 'T', audience: { kind: 'reporter_list', reporterIds: [] } }), res);
    expect(res.code).toBe(400);
    expect(NotificationCampaign.create).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });
});

describe('what gets saved', () => {
  test('only fields we expect — extra junk in the request is ignored', async () => {
    await ctrl.send(sendReq({
      type: 'simple', title: 'Hello', message: 'World',
      audience: { kind: 'all' },
      status: 'sent', sentBy: 'someone-else', recipientsEstimate: 99999, evil: true,
    }), mockRes());
    const saved = NotificationCampaign.create.mock.calls[0][0];
    expect(saved.status).toBe('draft');            // never 'sent' from the request
    expect(saved.recipientsEstimate).toBeUndefined();
    expect(saved.evil).toBeUndefined();
    expect(String(saved.sentBy)).not.toBe('someone-else');
  });

  test('buttons are capped by the design and given ids when the desk left them blank', async () => {
    await ctrl.send(sendReq({
      type: 'actions', title: 'T', audience: { kind: 'all' },
      buttons: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: '' }],
    }), mockRes());
    const saved = NotificationCampaign.create.mock.calls[0][0];
    expect(saved.buttons.map((b) => b.label)).toEqual(['A', 'B']);
    expect(saved.buttons.every((b) => b.id)).toBe(true);
  });

  test('a poll design is marked as a poll, a plain one is not', async () => {
    await ctrl.send(sendReq({ type: 'poll_yes_no', title: 'T', audience: { kind: 'all' } }), mockRes());
    expect(NotificationCampaign.create.mock.calls[0][0].poll.enabled).toBe(true);
    NotificationCampaign.create.mockClear();
    await ctrl.send(sendReq({ type: 'simple', title: 'T', audience: { kind: 'all' } }), mockRes());
    expect(NotificationCampaign.create.mock.calls[0][0].poll.enabled).toBe(false);
  });

  test('ids that are not real ObjectIds are dropped instead of crashing the send', async () => {
    const good = oid();
    await ctrl.send(sendReq({
      type: 'simple', title: 'T',
      audience: { kind: 'reporter_list', reporterIds: [String(good), 'not-an-id', ''] },
    }), mockRes());
    const saved = NotificationCampaign.create.mock.calls[0][0];
    expect(saved.audience.reporterIds.map(String)).toEqual([String(good)]);
  });
});

describe('test sends', () => {
  test('a test goes to the admin who pressed it, and is never marked as a real send', async () => {
    sender.send.mockResolvedValue({ id: 'x', recipients: 1, describe: 'Test send (you only)', test: true });
    const req = sendReq({ type: 'simple', title: 'T', audience: { kind: 'all' }, test: true });
    await ctrl.send(req, mockRes());
    expect(sender.send.mock.calls[0][1].testAlias).toBe(req.admin.id);
    expect(NotificationCampaign.create.mock.calls[0][0].status).toBe('test');
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('when one person is picked, the test goes to THEM (reporter and user aliases differ)', async () => {
    sender.send.mockResolvedValue({ id: 'x', recipients: 1, describe: 'Test', test: true });
    const r = oid();
    await ctrl.send(sendReq({ type: 'simple', title: 'T', test: true, audience: { kind: 'reporter_list', reporterIds: [String(r)] } }), mockRes());
    expect(sender.send.mock.calls[0][1].testAlias).toBe(String(r));

    sender.send.mockClear();
    const u = oid();
    // A reader's alias is their Google id, so the controller must look it up
    // instead of guessing from the Mongo id.
    User.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: u, googleId: 'g-777' }]) }) });
    await ctrl.send(sendReq({ type: 'simple', title: 'T', test: true, audience: { kind: 'user_list', userIds: [String(u)] } }), mockRes());
    expect(sender.send.mock.calls[0][1].testAlias).toBe('u:g-777');
  });

  test('a test that reached no phone says so plainly instead of claiming success', async () => {
    sender.send.mockResolvedValue({ id: 'x', recipients: 0, describe: 'Test send (you only)', test: true });
    const res = mockRes();
    await ctrl.send(sendReq({ type: 'simple', title: 'T', audience: { kind: 'all' }, test: true }), res);
    expect(res.code).toBe(200);
    expect(res.body.warning).toMatch(/no phone registered/i);
  });

  test('a test with an EMPTY named list still only reaches the admin — never everyone', async () => {
    sender.send.mockResolvedValue({ id: 'x', recipients: 1, describe: 'Test', test: true });
    const req = sendReq({ type: 'simple', title: 'T', test: true, audience: { kind: 'reporter_list', reporterIds: [] } });
    await ctrl.send(req, mockRes());
    expect(sender.send.mock.calls[0][1].testAlias).toBe(req.admin.id);
  });
});

describe('sending the same thing twice', () => {
  const same = { type: 'simple', title: 'వరద హెచ్చరిక', message: 'జాగ్రత్త', audience: { kind: 'all' } };

  test('a repeat within the window is refused, so readers are not notified twice', async () => {
    NotificationCampaign.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ sentAt: new Date(Date.now() - 20000) }) }),
    });
    const res = mockRes();
    await ctrl.send(sendReq({ ...same }), res);
    expect(res.code).toBe(409);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.secondsAgo).toBeGreaterThan(0);
    expect(sender.send).not.toHaveBeenCalled();      // nothing left the server
    expect(NotificationCampaign.create).not.toHaveBeenCalled();
  });

  test('the desk can still say "send it again anyway"', async () => {
    NotificationCampaign.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ sentAt: new Date() }) }),
    });
    const res = mockRes();
    await ctrl.send(sendReq({ ...same, confirmDuplicate: true }), res);
    expect(res.code).toBe(200);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  test('nothing recent → it just sends', async () => {
    NotificationCampaign.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });
    const res = mockRes();
    await ctrl.send(sendReq({ ...same }), res);
    expect(res.code).toBe(200);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  test('a TEST send is never blocked — testing twice must always work', async () => {
    NotificationCampaign.findOne.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ sentAt: new Date() }) }),
    });
    sender.send.mockResolvedValue({ id: 'x', recipients: 1, describe: 'Test', test: true });
    const res = mockRes();
    await ctrl.send(sendReq({ ...same, test: true }), res);
    expect(res.code).toBe(200);
    expect(NotificationCampaign.findOne).not.toHaveBeenCalled();
  });

  test('the check looks at content + audience, and only at sends that really went out', async () => {
    NotificationCampaign.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });
    await ctrl.send(sendReq({ ...same }), mockRes());
    const q = NotificationCampaign.findOne.mock.calls[0][0];
    expect(q.status).toBe('sent');                   // a failed attempt must not block a retry
    expect(q.type).toBe('simple');
    expect(q.title).toBe('వరద హెచ్చరిక');
    expect(q.message).toBe('జాగ్రత్త');
    expect(q['audience.kind']).toBe('all');
    expect(q.sentAt.$gte).toBeInstanceOf(Date);
  });
});

describe('a real send is recorded', () => {
  test('the audit trail names the design, the audience and how many phones', async () => {
    await ctrl.send(sendReq({ type: 'urgent', title: 'Flood alert', audience: { kind: 'all' } }), mockRes());
    expect(logAudit).toHaveBeenCalledTimes(1);
    const entry = logAudit.mock.calls[0][0];
    expect(entry.action).toBe('notification_sent');
    expect(entry.description).toContain('Flood alert');
    expect(entry.description).toContain('Everyone');
    expect(entry.after).toMatchObject({ type: 'urgent', audience: 'all', recipients: 5 });
  });

  test('when OneSignal refuses, the failure is reported and nothing is audited as sent', async () => {
    const err = new Error('OneSignal rejected the notification: bad key');
    err.status = 502;
    sender.send.mockRejectedValue(err);
    const res = mockRes();
    await ctrl.send(sendReq({ type: 'simple', title: 'T', audience: { kind: 'all' } }), res);
    expect(res.code).toBe(502);
    expect(res.body.error).toMatch(/OneSignal rejected/);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('preview', () => {
  test('shows the payload and who it would reach, without sending anything', async () => {
    const res = mockRes();
    await ctrl.preview({ body: { type: 'big_image', title: 'T', imageUrl: 'https://x/i.jpg', audience: { kind: 'all' } } }, res);
    expect(res.body.preview.type).toBe('big_image');
    expect(res.body.native.big_picture).toBe('https://x/i.jpg');
    expect(res.body.audience.describe).toBe('Everyone');
    expect(sender.send).not.toHaveBeenCalled();
  });

  test('an audience that is not chosen yet is shown as a message, not an error page', async () => {
    const res = mockRes();
    await ctrl.preview({ body: { type: 'simple', title: 'T', audience: { kind: 'district', district: '' } } }, res);
    expect(res.code).toBe(200);
    expect(res.body.audience.describe).toMatch(/Choose a district/);
  });
});

describe('people search', () => {
  test('one letter searches nothing (it would match half the database)', async () => {
    const res = mockRes();
    await ctrl.searchPeople({ query: { q: 'a', who: 'reporter' } }, res);
    expect(res.body.people).toEqual([]);
    expect(Admin.find).not.toHaveBeenCalled();
  });

  test('regex characters in the name are treated as text, not as a pattern', async () => {
    Admin.find.mockReturnValue({ select: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });
    await ctrl.searchPeople({ query: { q: 'a.*(b', who: 'reporter' } }, mockRes());
    const rx = Admin.find.mock.calls[0][0].$or[0].name;
    expect(rx.test('a.*(b')).toBe(true);
    expect(rx.test('axxxb')).toBe(false);
  });

  test('reporters and app users come from their own collections', async () => {
    Admin.find.mockReturnValue({ select: () => ({ limit: () => ({ lean: () => Promise.resolve([{ _id: oid(), name: 'Ravi', mobileNumber: '9876543210', assignedDistricts: ['Krishna'] }]) }) }) });
    const res1 = mockRes();
    await ctrl.searchPeople({ query: { q: 'ravi', who: 'reporter' } }, res1);
    expect(res1.body.people[0]).toMatchObject({ name: 'Ravi', sub: '9876543210 · Krishna' });

    User.find.mockReturnValue({ select: () => ({ limit: () => ({ lean: () => Promise.resolve([{ _id: oid(), displayName: 'Sita' }]) }) }) });
    const res2 = mockRes();
    await ctrl.searchPeople({ query: { q: 'sita', who: 'user' } }, res2);
    expect(res2.body.people[0].name).toBe('Sita');
  });
});

describe('attaching a news article (what makes a tap open it)', () => {
  test('the picked article travels all the way into the payload', async () => {
    const news = oid();
    await ctrl.send(sendReq({ type: 'image', title: 'T', newsId: String(news), audience: { kind: 'all' } }), mockRes());
    expect(String(NotificationCampaign.create.mock.calls[0][0].newsId)).toBe(String(news));
  });

  test('no article attached → no newsId, and the tap can only open the app', async () => {
    await ctrl.send(sendReq({ type: 'simple', title: 'T', audience: { kind: 'all' } }), mockRes());
    expect(NotificationCampaign.create.mock.calls[0][0].newsId).toBeNull();
  });

  test('a junk news id is dropped rather than saved', async () => {
    await ctrl.send(sendReq({ type: 'simple', title: 'T', newsId: 'not-an-id', audience: { kind: 'all' } }), mockRes());
    expect(NotificationCampaign.create.mock.calls[0][0].newsId).toBeNull();
  });

  test('the news list shows recent published articles with a usable image', async () => {
    const News = require('../models/News');
    News.find.mockReturnValue({ select: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([
      { _id: oid(), title: 'వరద హెచ్చరిక', content: 'గోదావరి ఉధృతి', mediaUrl: 'https://x/a.jpg', category: 'News', location: 'Krishna' },
      { _id: oid(), title: 'వీడియో వార్త', content: 'c', mediaType: 'video', thumbnailUrl: 'https://x/thumb.jpg', mediaUrl: 'https://x/v.mp4' },
    ]) }) }) }) });
    const res = mockRes();
    await ctrl.searchNews({ query: { q: 'వరద' } }, res);
    expect(News.find.mock.calls[0][0].isActive).toBe(true);
    expect(res.body.news[0].title).toBe('వరద హెచ్చరిక');
    expect(res.body.news[0].image).toBe('https://x/a.jpg');
    // a video article offers its thumbnail, never the .mp4
    expect(res.body.news[1].image).toBe('https://x/thumb.jpg');
    expect(res.body.news[1].isVideo).toBe(true);
  });

  test('an empty search still lists the latest news, newest first', async () => {
    const News = require('../models/News');
    const sort = jest.fn(() => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }));
    News.find.mockReturnValue({ select: () => ({ sort }) });
    await ctrl.searchNews({ query: {} }, mockRes());
    expect(News.find.mock.calls[0][0].title).toBeUndefined(); // no filter, just recent
    expect(sort).toHaveBeenCalledWith({ publishedAt: -1 });
  });
});

describe('choosing where a tap goes', () => {
  test('a page the app knows is saved; anything else is dropped', async () => {
    await ctrl.send(sendReq({ type: 'simple', title: 'T', route: 'quiz', audience: { kind: 'all' } }), mockRes());
    expect(NotificationCampaign.create.mock.calls[0][0].route).toBe('quiz');

    NotificationCampaign.create.mockClear();
    await ctrl.send(sendReq({ type: 'simple', title: 'T', route: 'polls', audience: { kind: 'all' } }), mockRes());
    expect(NotificationCampaign.create.mock.calls[0][0].route).toBe('');
  });

  test('the dashboard is told which pages it may offer', async () => {
    const res = mockRes();
    await ctrl.getOptions({}, res);
    expect(res.body.appRoutes.map((r) => r.key)).toContain('train');
    expect(res.body.appRoutes.map((r) => r.key)).not.toContain('polls');
  });
});

describe('the app voting on a poll', () => {
  test('a good vote is passed through with the device as the voter', async () => {
    sender.vote.mockResolvedValue({ counts: { yes: 1 }, total: 1, changed: false });
    const id = String(oid());
    const res = mockRes();
    await ctrl.publicVote({ body: { campaignId: id, optionId: 'yes', voterKey: 'dev-1' }, headers: {} }, res);
    expect(sender.vote).toHaveBeenCalledWith(expect.objectContaining({ campaignId: id, optionId: 'yes', voterKey: 'dev-1' }));
    expect(res.body).toMatchObject({ ok: true, total: 1 });
  });

  test('the device header is accepted when the app does not put it in the body', async () => {
    sender.vote.mockResolvedValue({ counts: {}, total: 0, changed: false });
    await ctrl.publicVote({ body: { campaignId: String(oid()), optionId: 'no' }, headers: { 'x-device-id': 'hdr-dev' } }, mockRes());
    expect(sender.vote.mock.calls[0][0].voterKey).toBe('hdr-dev');
  });

  test('a junk poll id, a missing option or an unknown device is refused', async () => {
    const bad = [
      { body: { campaignId: 'nope', optionId: 'yes', voterKey: 'd' }, headers: {} },
      { body: { campaignId: String(oid()), optionId: '', voterKey: 'd' }, headers: {} },
      { body: { campaignId: String(oid()), optionId: 'yes' }, headers: {} },
    ];
    for (const req of bad) {
      const res = mockRes();
      await ctrl.publicVote(req, res);
      expect(res.code).toBe(400);
    }
    expect(sender.vote).not.toHaveBeenCalled();
  });
});

describe('the page itself', () => {
  test('renders with every design so the picker is never short', () => {
    const res = mockRes();
    ctrl.renderPage({ admin: asAdmin() }, res);
    expect(res.rendered.view).toBe('notification-studio');
    // 18 from the printed chart + the picture-only design added later
    expect(res.rendered.data.notificationTypes).toHaveLength(19);
  });

  test('districts are looked up under the chosen state only', async () => {
    Location.distinct.mockResolvedValue(['Krishna', 'Guntur']);
    const res = mockRes();
    await ctrl.getDistricts({ query: { state: 'Andhra Pradesh' } }, res);
    expect(Location.distinct).toHaveBeenCalledWith('name', { locationType: 'district', parentName: 'Andhra Pradesh' });
    expect(res.body.districts).toEqual(['Guntur', 'Krishna']);
  });

  test('no state chosen → no district lookup at all', async () => {
    const res = mockRes();
    await ctrl.getDistricts({ query: {} }, res);
    expect(Location.distinct).not.toHaveBeenCalled();
    expect(res.body.districts).toEqual([]);
  });
});
