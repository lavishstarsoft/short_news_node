'use strict';

/**
 * API for the "Tehelka Incharge" app. The thing that matters most: an In-Charge
 * sees in the app exactly what the dashboard shows them — and a reporter who
 * signs in to the app sees nothing at all.
 */

jest.mock('../models/Admin', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/News', () => ({ find: jest.fn(), countDocuments: jest.fn(async () => 0), exists: jest.fn(async () => null) }));
jest.mock('../models/StaffPresence', () => {
  const StaffPresence = { findOne: jest.fn(), updateOne: jest.fn(async () => ({})), find: jest.fn() };
  StaffPresence.StaffPresence = StaffPresence;
  StaffPresence.StaffPresenceLog = { create: jest.fn(async () => ({})), find: jest.fn() };
  return StaffPresence;
});
// Only the pending-queue filter is faked (so the queue tests can assert the
// controller hands it the right base query); every other helper — tab
// resolution, managed reporters, team scope — is the REAL code, because the
// News List / Rejected / Plagiarism tests exist to prove the app scopes the
// same way the web pages do.
jest.mock('../utils/editorCoverageHelper', () => ({
  ...jest.requireActual('../utils/editorCoverageHelper'),
  buildPendingNewsFilterForSubEditor: jest.fn(async (_A, _doc, q) => ({ ...q, scopedFor: 'this-incharge' })),
}));

const Admin = require('../models/Admin');
const News = require('../models/News');
const { buildPendingNewsFilterForSubEditor } = require('../utils/editorCoverageHelper');
const StaffPresence = require('../models/StaffPresence');
const { StaffPresenceLog } = require('../models/StaffPresence');
const esc = require('../services/incharge/escalation');
const ctrl = require('../controllers/inchargeAppController');

function mockRes() {
  const res = { code: 200, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const lean = (v) => ({ select: () => ({ lean: () => Promise.resolve(v) }) });
const newsChain = (rows) => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve(rows) }) }) }) });

beforeEach(() => {
  jest.clearAllMocks();
  ctrl._test.resetMonitorCache();
});

describe('who may use the app', () => {
  const { canUseInchargeApp } = ctrl._test;

  test('Bureau, State In-Charges, Sub-Editors and admins', () => {
    expect(canUseInchargeApp({ role: 'editor', displayRole: 'State In-Charge' })).toBe(true);
    expect(canUseInchargeApp({ role: 'subeditor', displayRole: 'Telangana Incharge' })).toBe(true);
    // Bureau accounts in this database are role subeditor + displayRole "Bureau".
    expect(canUseInchargeApp({ role: 'subeditor', displayRole: 'Bureau' })).toBe(true);
    // A plain Sub-Editor with no designation may use it too.
    expect(canUseInchargeApp({ role: 'subeditor', displayRole: 'Sub-Editor' })).toBe(true);
    expect(canUseInchargeApp({ role: 'subeditor' })).toBe(true);
    // ...and a Bureau designation is honoured even on a non-subeditor account.
    expect(canUseInchargeApp({ role: 'editor', displayRole: 'Bihar Bureau' })).toBe(true);
    expect(canUseInchargeApp({ role: 'admin' })).toBe(true);
    expect(canUseInchargeApp({ role: 'superadmin' })).toBe(true);
  });

  test('not a plain reporter, not nobody', () => {
    expect(canUseInchargeApp({ role: 'editor', displayRole: 'Staff Reporter' })).toBe(false);
    expect(canUseInchargeApp({ role: 'editor', displayRole: 'Crime Reporter' })).toBe(false);
    expect(canUseInchargeApp({ role: 'editor' })).toBe(false);
    expect(canUseInchargeApp(null)).toBe(false);
  });

  test('a reporter who signs in to the app is refused BY THE SERVER, with no data read', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'r1', role: 'editor', displayRole: 'Staff Reporter' }));
    const res = mockRes();
    await ctrl.pending({ admin: { id: 'r1' } }, res);
    expect(res.code).toBe(403);
    expect(News.find).not.toHaveBeenCalled();
  });

  test("the app's copy of this rule accepts exactly the same people", () => {
    // The app has to make the same decision as canUseInchargeApp() above, or a
    // Sub-Editor is shown a login that works and then a server that refuses
    // them — or worse, a reporter is let past the app and relies on the server
    // alone. The Flutter source sits beside this repo on a developer's machine
    // and is never deployed, so the cross-check only runs where it exists.
    const fs = require('fs');
    const appFile = require('path')
      .join(__dirname, '..', '..', 'state_incharge', 'lib', 'services', 'auth.dart');
    if (!fs.existsSync(appFile)) return;

    const src = fs.readFileSync(appFile, 'utf8');
    const start = src.indexOf('static bool isAllowed');
    expect(start).toBeGreaterThan(-1);
    const rule = src.slice(start, src.indexOf('\n  }', start));

    // Every role and title the server accepts, and nothing more.
    const inApp = [...new Set([...rule.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]))].sort();
    expect(inApp).toEqual(['admin', 'bureau', 'in-charge', 'incharge', 'subeditor', 'superadmin']);
    inApp.forEach((token) => {
      const asRole = { role: token };
      const asTitle = { role: 'editor', displayRole: token };
      expect(canUseInchargeApp(asRole) || canUseInchargeApp(asTitle)).toBe(true);
    });
  });

  test('a deactivated account is treated as signed out', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'i1', role: 'editor', displayRole: 'State In-Charge', isActive: false }));
    const res = mockRes();
    await ctrl.pending({ admin: { id: 'i1' } }, res);
    expect(res.code).toBe(401);
  });
});

describe('the queue', () => {
  const incharge = { _id: 'i1', role: 'editor', displayRole: 'State In-Charge', isActive: true };

  test('uses the dashboard\'s own scope filter — the same news the web page shows', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    News.find.mockReturnValue(newsChain([]));
    await ctrl.pending({ admin: { id: 'i1' } }, mockRes());
    expect(buildPendingNewsFilterForSubEditor).toHaveBeenCalledTimes(1);
    const q = News.find.mock.calls[0][0];
    expect(q.scopedFor).toBe('this-incharge');
    expect(q.isActive).toBe(false);                      // pending only
    expect(q.authorId).toEqual({ $ne: 'i1' });           // never your own news
    expect(q.aiStatus).toEqual({ $in: ['none'] });       // same as the web page for an In-Charge
  });

  test('never selects the super-admin-only phone / GPS / IP stamp', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    const select = jest.fn(() => ({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }));
    News.find.mockReturnValue({ select });
    await ctrl.pending({ admin: { id: 'i1' } }, mockRes());
    expect(select.mock.calls[0][0]).not.toMatch(/postedFrom/);
  });

  test('returns a compact list with the author\'s name and a usable picture', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    News.find.mockReturnValue(newsChain([
      { _id: 'n1', title: 'వరద', content: 'x'.repeat(900), authorId: 'a1', publishedAt: new Date('2026-09-26T06:00:00Z'), mediaUrl: 'https://x/a.jpg' },
      { _id: 'n2', title: 'వీడియో', authorId: 'a2', publishedAt: new Date('2026-09-26T06:10:00Z'), mediaType: 'video', thumbnailUrl: 'https://x/t.jpg', mediaUrl: 'https://x/v.mp4' },
    ]));
    Admin.find.mockReturnValue(lean([{ _id: 'a1', name: 'Ravi' }, { _id: 'a2', username: 'sita99' }]));
    const res = mockRes();
    await ctrl.pending({ admin: { id: 'i1' } }, res);
    const [a, b] = res.body.news;
    expect(a.authorName).toBe('Ravi');
    expect(a.content.length).toBe(280);                  // trimmed for a list
    expect(a.imageUrl).toBe('https://x/a.jpg');
    expect(b.authorName).toBe('sita99');
    expect(b.imageUrl).toBe('https://x/t.jpg');          // a thumbnail, never the .mp4
    expect(b.isVideo).toBe(true);
  });

  test('a resent card carries the In-Charge\'s own send-back note, so they see what the fix was for', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    const minsAgo = (m) => new Date(Date.now() - m * 60000);
    News.find.mockReturnValue(newsChain([
      // With the reporter — the note shows as "You asked".
      { _id: 'n1', title: 'a', authorId: 'a1', publishedAt: minsAgo(30),
        revisionStatus: { needsRevision: true, revisionCount: 1, remarks: 'Add the date' } },
      // Fixed and resent — the note must STILL be there, so the card can say "You had asked".
      { _id: 'n2', title: 'b', authorId: 'a2', publishedAt: minsAgo(180),
        revisionStatus: { needsRevision: false, revisionCount: 2, resubmittedAt: minsAgo(4), remarks: 'Add the date' } },
    ]));
    Admin.find.mockReturnValue(lean([{ _id: 'a1', name: 'Ravi' }, { _id: 'a2', name: 'Sita' }]));
    const res = mockRes();
    await ctrl.pending({ admin: { id: 'i1' } }, res);
    const byId = Object.fromEntries(res.body.news.map((n) => [n.id, n]));
    expect(byId.n1).toMatchObject({ waitingOnReporter: true, sentBackRemarks: 'Add the date' });
    expect(byId.n2).toMatchObject({ resent: true, revisionCount: 2, waitingOnReporter: false, sentBackRemarks: 'Add the date' });
  });

  test('admins see the wider queue, exactly as on the web', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'ad', role: 'admin', isActive: true }));
    News.find.mockReturnValue(newsChain([]));
    await ctrl.pending({ admin: { id: 'ad' } }, mockRes());
    expect(News.find.mock.calls[0][0].aiStatus).toEqual({ $in: ['none', 'processing', 'review_required', 'failed'] });
  });
});


describe('the escalation clock', () => {
  test('the owner\'s thresholds, and the app\'s copy of them, agree', () => {
    // lib/utils/waiting.dart holds the same three numbers. If these ever drift,
    // an In-Charge gets an alarm the desk does not count as late — or worse,
    // the desk reports someone whose phone never rang.
    expect(esc.SOON_MINUTES).toBe(15);
    expect(esc.ALARM_MINUTES).toBe(30);
    expect(esc.ESCALATE_MINUTES).toBe(40);

    // The Flutter source sits beside this repo on a developer's machine but is
    // never deployed to the server, so the cross-check only runs where it is.
    const fs = require('fs');
    const appFile = require('path')
      .join(__dirname, '..', '..', 'state_incharge', 'lib', 'utils', 'waiting.dart');
    if (!fs.existsSync(appFile)) return;

    const app = fs.readFileSync(appFile, 'utf8');
    expect(app).toContain(`soonAfterMinutes = ${esc.SOON_MINUTES}`);
    expect(app).toContain(`lateAfterMinutes = ${esc.ALARM_MINUTES}`);
    expect(app).toContain(`escalateAfterMinutes = ${esc.ESCALATE_MINUTES}`);
  });

  test('levels step up at exactly the right minute', () => {
    expect(esc.levelFor(29)).toBe('soon');
    expect(esc.levelFor(30)).toBe('alarm');
    expect(esc.levelFor(39)).toBe('alarm');
    expect(esc.levelFor(40)).toBe('escalate');
    expect(esc.levelFor(60)).toBe('escalate2');
    expect(esc.shouldAlarm(29)).toBe(false);
    expect(esc.shouldAlarm(30)).toBe(true);
    expect(esc.shouldTellAdmin(39)).toBe(false);
    expect(esc.shouldTellAdmin(40)).toBe(true);
  });

  test('a future timestamp (phone clock ahead) never reads as negative', () => {
    const later = new Date(Date.now() + 5 * 60000);
    expect(esc.minutesWaiting(later)).toBe(0);
    expect(esc.minutesWaiting('nonsense')).toBe(0);
  });
});

describe('the heartbeat', () => {
  const incharge = { _id: 'i1', role: 'editor', displayRole: 'State In-Charge', isActive: true, name: 'Raju' };
  const req = (body) => ({ admin: { id: 'i1' }, body, headers: {} });

  beforeEach(() => {
    Admin.findById.mockReturnValue(lean(incharge));
    StaffPresence.findOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    News.find.mockReturnValue({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }) });
    News.countDocuments.mockResolvedValue(0);
  });

  test('a reporter cannot report a position into the system', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'r', role: 'editor', displayRole: 'Staff Reporter', isActive: true }));
    const res = mockRes();
    await ctrl.heartbeat(req({ duty: 'on', gps: { lat: 17, lng: 78 } }), res);
    expect(res.code).toBe(403);
    expect(StaffPresence.updateOne).not.toHaveBeenCalled();
  });

  test('OFF DUTY: the position is thrown away, everything else is kept', async () => {
    await ctrl.heartbeat(req({
      duty: 'off', gps: { lat: 17.3, lng: 78.4 }, batteryPercent: 62, wifi: true, network: 'wifi',
    }), mockRes());
    const saved = StaffPresence.updateOne.mock.calls[0][1].$set;
    expect(saved.duty).toBe('off');
    expect(saved.gps).toEqual({});              // no location kept off duty
    expect(saved.batteryPercent).toBe(62);      // but the rest still reported
    expect(saved.signal.wifi).toBe(true);
  });

  test('ON DUTY: the position is kept, and a fake one is flagged', async () => {
    await ctrl.heartbeat(req({
      duty: 'on', gps: { lat: 17.3, lng: 78.4, accuracy: 9, mock: true },
    }), mockRes());
    const saved = StaffPresence.updateOne.mock.calls[0][1].$set;
    expect(saved.gps.lat).toBe(17.3);
    expect(saved.gps.mock).toBe(true);          // reused from reporter security
  });

  test('junk readings are clamped instead of stored', async () => {
    await ctrl.heartbeat(req({ duty: 'on', batteryPercent: 999, signalBars: 77 }), mockRes());
    const saved = StaffPresence.updateOne.mock.calls[0][1].$set;
    expect(saved.batteryPercent).toBe(100);
    expect(saved.signal.bars).toBe(4);
  });

  test('the SERVER decides whether to ring — the phone is never asked', async () => {
    const minsAgo = (m) => new Date(Date.now() - m * 60000);
    News.find.mockReturnValue({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [
      { publishedAt: minsAgo(34) }, { publishedAt: minsAgo(10) }, { publishedAt: minsAgo(2) },
    ] }) }) }) });
    const res = mockRes();
    await ctrl.heartbeat(req({ duty: 'on' }), res);
    expect(res.body.alarm).toBe(true);
    expect(res.body.level).toBe('alarm');
    expect(res.body.pendingOldestMinutes).toBeGreaterThanOrEqual(34);
    expect(res.body.pendingCount).toBe(3);
  });

  test('an item SENT BACK is the reporter\'s turn — it never rings the alarm', async () => {
    const minsAgo = (m) => new Date(Date.now() - m * 60000);
    News.find.mockReturnValue({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [
      { publishedAt: minsAgo(300), revisionStatus: { needsRevision: true } },   // sent back 5 hours ago
      { publishedAt: minsAgo(5) },
    ] }) }) }) });
    const res = mockRes();
    await ctrl.heartbeat(req({ duty: 'on' }), res);
    expect(res.body.alarm).toBe(false);
    expect(res.body.pendingOldestMinutes).toBe(5);
    expect(res.body.pendingCount).toBe(1);
  });

  test('a RESENT item counts from when it came back, not from first filing', async () => {
    const minsAgo = (m) => new Date(Date.now() - m * 60000);
    News.find.mockReturnValue({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [
      // Filed 3 hours ago, sent back, fixed and resent 4 minutes ago.
      { publishedAt: minsAgo(180), revisionStatus: { needsRevision: false, revisionCount: 1, resubmittedAt: minsAgo(4) } },
    ] }) }) }) });
    const res = mockRes();
    await ctrl.heartbeat(req({ duty: 'on' }), res);
    expect(res.body.alarm).toBe(false);
    expect(res.body.pendingOldestMinutes).toBe(4);
  });

  test('nothing waiting → no alarm', async () => {
    const res = mockRes();
    await ctrl.heartbeat(req({ duty: 'on' }), res);
    expect(res.body.alarm).toBe(false);
    expect(res.body.level).toBe('fresh');
  });

  test('the history is written too, so "my signal was weak" can be checked later', async () => {
    await ctrl.heartbeat(req({ duty: 'on', signalBars: 1, network: 'mobile' }), mockRes());
    expect(StaffPresenceLog.create).toHaveBeenCalledTimes(1);
    expect(StaffPresenceLog.create.mock.calls[0][0].signal.bars).toBe(1);
  });

  test('a failed history write does not fail the heartbeat', async () => {
    StaffPresenceLog.create.mockRejectedValueOnce(new Error('disk full'));
    const res = mockRes();
    await ctrl.heartbeat(req({ duty: 'on' }), res);
    expect(res.code).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('the desk monitor', () => {
  const { mapLimited } = ctrl._test;
  const staffChain = (rows) => ({ select: () => ({ lean: () => Promise.resolve(rows) }) });

  test('lists Bureau, In-Charges and Sub-Editors — the same people who may log in', async () => {
    Admin.find.mockReturnValue(staffChain([]));
    StaffPresence.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    await ctrl.monitor({}, mockRes());

    const q = Admin.find.mock.calls[0][0];
    const [byRole] = q.$or.filter((c) => c.role);
    const [byTitle] = q.$or.filter((c) => c.displayRole);
    expect(byRole.role.$in).toEqual(expect.arrayContaining(['admin', 'superadmin', 'subeditor']));
    expect(byTitle.displayRole.test('Bureau')).toBe(true);
    expect(byTitle.displayRole.test('State In-Charge')).toBe(true);
    expect(byTitle.displayRole.test('Staff Reporter')).toBe(false);
  });

  test('a repeat refresh is served from cache instead of re-querying the database', async () => {
    Admin.find.mockReturnValue(staffChain([]));
    StaffPresence.find.mockReturnValue({ lean: () => Promise.resolve([]) });

    const first = mockRes();
    await ctrl.monitor({}, first);
    const second = mockRes();
    await ctrl.monitor({}, second);

    expect(Admin.find).toHaveBeenCalledTimes(1);
    expect(second.body).toBe(first.body);
  });

  test('never asks the database more than 8 questions at once', async () => {
    let running = 0;
    let peak = 0;
    const done = await mapLimited([...Array(30).keys()], 8, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setImmediate(r));
      running -= 1;
      return n * 2;
    });
    expect(peak).toBe(8);
    // ...and every person is still answered for, in their original order.
    expect(done).toEqual([...Array(30).keys()].map((n) => n * 2));
  });
});

describe('what this person may do', () => {
  const { capabilitiesFor } = ctrl._test;

  test('the pending page gates Approve, Save, Reject and Send-back on ONE flag', () => {
    // views/pending-news.ejs uses `canApproveNewsJs` for all four buttons, so
    // the app must not invent a separate rule for editing a pending item.
    expect(capabilitiesFor({ role: 'subeditor', permissions: { canApproveNews: true } }).canApprove).toBe(true);
    expect(capabilitiesFor({ role: 'subeditor', permissions: { canApproveNews: false } }).canApprove).toBe(false);
    expect(capabilitiesFor({ role: 'subeditor', permissions: {} }).canApprove).toBe(false);
    expect(capabilitiesFor({ role: 'subeditor' }).canApprove).toBe(false);
    expect(capabilitiesFor({ role: 'admin' }).canApprove).toBe(true);
    expect(capabilitiesFor({ role: 'superadmin' }).canApprove).toBe(true);
  });

  test('notifications and published-news editing are separate permissions', () => {
    const only = capabilitiesFor({ role: 'subeditor', permissions: { canSendNotifications: true } });
    expect(only.canSendNotifications).toBe(true);
    expect(only.canApprove).toBe(false);
    expect(only.canEditPublished).toBe(false);

    const editor = capabilitiesFor({ role: 'subeditor', permissions: { canEditNews: true } });
    expect(editor.canEditPublished).toBe(true);
    expect(editor.canApprove).toBe(false);
  });

  test('/me refuses a reporter and never reveals a name', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'r1', role: 'editor', displayRole: 'Staff Reporter', name: 'Ravi' }));
    const res = mockRes();
    await ctrl.me({ admin: { id: 'r1' } }, res);
    expect(res.code).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('Ravi');
  });

  test('/me tells an In-Charge exactly which buttons to show', async () => {
    Admin.findById.mockReturnValue(lean({
      _id: 'i1', role: 'subeditor', displayRole: 'Bureau', name: 'Raju', isActive: true,
      permissions: { canApproveNews: true, canSendNotifications: false },
    }));
    const res = mockRes();
    await ctrl.me({ admin: { id: 'i1' } }, res);
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({
      ok: true, name: 'Raju', displayRole: 'Bureau',
      canApprove: true, canSendNotifications: false, canEditPublished: false,
    });
  });
});

describe('one news item in full', () => {
  const { imagesOf } = ctrl._test;
  const incharge = { _id: 'i1', role: 'subeditor', displayRole: 'Bureau', isActive: true, permissions: { canApproveNews: true } };
  const ID = '507f1f77bcf86cd799439011';
  const findOne = (doc) => ({ select: () => ({ lean: () => Promise.resolve(doc) }) });

  test('every picture, in preview order, with no blanks or repeats', () => {
    expect(imagesOf({ mediaUrl: 'a.jpg', imageUrl: 'a.jpg', imageUrls: ['b.jpg', '', 'a.jpg', 'c.jpg'] }))
      .toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    // A video shows its thumbnail here; the app plays the video itself.
    expect(imagesOf({ mediaType: 'video', mediaUrl: 'clip.mp4', thumbnailUrl: 't.jpg' })).toEqual(['t.jpg']);
    expect(imagesOf({})).toEqual([]);
  });

  test('the full text is returned, not the list teaser', async () => {
    const long = 'x'.repeat(900);
    Admin.findById.mockReturnValue(lean(incharge));
    News.findOne = jest.fn().mockReturnValue(findOne({
      _id: ID, title: 'T', content: long, publishedAt: new Date(), imageUrls: ['i.jpg'],
      duplicateCheck: { isDuplicate: true, score: 91, similarArticles: [{ id: 'x' }] },
      revisionStatus: { revisionCount: 2, lastChangeSummary: 'title fixed' },
    }));
    const res = mockRes();
    await ctrl.newsDetail({ admin: { id: 'i1' }, params: { id: ID } }, res);

    expect(res.code).toBe(200);
    expect(res.body.news.content.length).toBe(900);
    expect(res.body.news.duplicate).toMatchObject({ flagged: true, isDuplicate: true, score: 91, matchCount: 1 });
    expect(res.body.news.revisionCount).toBe(2);
  });

  test('the exact place the reporter searched is returned as a de-duplicated line', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    News.findOne = jest.fn().mockReturnValue(findOne({
      _id: ID, title: 'T', content: 'c', publishedAt: new Date(),
      location: 'Mulugu',
      postedPlace: { name: 'Bandarupalli', mandal: 'Mulugu', district: 'Mulugu', state: 'Telangana', type: 'village' },
    }));
    const res = mockRes();
    await ctrl.newsDetail({ admin: { id: 'i1' }, params: { id: ID } }, res);
    // Repeated "Mulugu" collapses to one; the fuller line beats the bare location.
    expect(res.body.news.postedPlace.full).toBe('Bandarupalli · Mulugu · Telangana');
    expect(res.body.news.location).toBe('Mulugu');
  });

  test('no postedPlace (web / old app) → an empty place line, never a crash', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    News.findOne = jest.fn().mockReturnValue(findOne({ _id: ID, title: 'T', content: 'c', publishedAt: new Date(), location: 'Karimnagar' }));
    const res = mockRes();
    await ctrl.newsDetail({ admin: { id: 'i1' }, params: { id: ID } }, res);
    expect(res.body.news.postedPlace.full).toBe('');
  });

  test('an AI flag with nothing to compare against is NOT shown as a flag', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    News.findOne = jest.fn().mockReturnValue(findOne({
      _id: ID, title: 'T', content: 'c', publishedAt: new Date(),
      duplicateCheck: { isDuplicate: true, score: 88, similarArticles: [] },
    }));
    const res = mockRes();
    await ctrl.newsDetail({ admin: { id: 'i1' }, params: { id: ID } }, res);
    expect(res.body.news.duplicate.flagged).toBe(false);
  });

  test('it is read through the SAME scope as the queue — no peeking at other teams', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    News.findOne = jest.fn().mockReturnValue(findOne(null));
    const res = mockRes();
    await ctrl.newsDetail({ admin: { id: 'i1' }, params: { id: ID } }, res);

    const q = News.findOne.mock.calls[0][0];
    expect(q._id).toBe(ID);
    expect(q.isActive).toBe(false);                       // still pending
    expect(q.authorId).toEqual({ $ne: 'i1' });            // not their own
    expect(q.scopedFor).toBe('this-incharge');            // the dashboard's own filter
    // Already approved by someone else is an ordinary 404, not an error.
    expect(res.code).toBe(404);
  });

  test('the phone/GPS/IP of the reporter is never even read', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    let selected = '';
    News.findOne = jest.fn().mockReturnValue({
      select: (f) => { selected = f; return { lean: async () => null }; },
    });
    await ctrl.newsDetail({ admin: { id: 'i1' }, params: { id: ID } }, mockRes());
    expect(selected).not.toMatch(/postedFrom/);
  });

  test('a bad id is refused before any database work', async () => {
    Admin.findById.mockClear();
    const res = mockRes();
    await ctrl.newsDetail({ admin: { id: 'i1' }, params: { id: 'not-an-id' } }, res);
    expect(res.code).toBe(400);
    expect(Admin.findById).not.toHaveBeenCalled();
  });

  test('a reporter is refused before the news is read', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'r1', role: 'editor', displayRole: 'Staff Reporter', isActive: true }));
    News.findOne = jest.fn();
    const res = mockRes();
    await ctrl.newsDetail({ admin: { id: 'r1' }, params: { id: ID } }, res);
    expect(res.code).toBe(403);
    expect(News.findOne).not.toHaveBeenCalled();
  });
});

describe('the late-approval reason, as the app sees it', () => {
  const late = require('../services/earning/lateApprovalService');

  test('the app\'s copy of the rule agrees with the server\'s, number for number', () => {
    // The alarm rings at 30 minutes and the server refuses an approval past 30
    // minutes without a reason, so this dialog is on the ordinary path, not an
    // edge case. The app checks the same rule as you type — an In-Charge on one
    // bar of signal must not learn their sentence is too short from a round
    // trip that may never complete. If the two drift, they are told "too
    // short" by a server that never says why.
    const fs = require('fs');
    const appFile = require('path')
      .join(__dirname, '..', '..', 'state_incharge', 'lib', 'utils', 'late_reason.dart');
    if (!fs.existsSync(appFile)) return;
    const src = fs.readFileSync(appFile, 'utf8');

    expect(src).toContain('minLength = 15');
    expect(src).toContain('minWords = 3');
    expect(src).toContain('minDistinctChars = 6');

    // The same list of words the server throws out, and nothing else.
    const inApp = [...src.matchAll(/'([a-z/]+)',/g)].map((m) => m[1]);
    const serverTrivial = ['ok', 'okay', 'busy', 'other', 'na', 'n/a', 'none',
      'done', 'yes', 'no', 'test', 'asdf', 'fine', 'late', 'sorry'];
    serverTrivial.forEach((w) => expect(inApp).toContain(w));
    serverTrivial.forEach((w) => expect(late.isValidReason(w)).toBe(false));

    // And the same verdicts on real text, either side.
    const cases = [
      ['I was travelling and had no network until now', true],
      ['नेटवर्क नहीं था इसलिए देर हुई', true],
      ['busy', false],
      ['aaa aaa aaa aaa aaa', false],
      ['aaaaaaaaaaaaaaaaaaaa', false],
      ['a'.repeat(14), false],
    ];
    cases.forEach(([text, ok]) => {
      expect(late.isValidReason(text)).toBe(ok);
    });
  });
});

describe('what a rejection and a send-back must carry', () => {
  // These are the rules the app has to enforce BEFORE queueing a decision.
  // Getting them wrong is worse than an ordinary bug: the In-Charge sees
  // "Rejected", walks away, and only learns minutes later that the server
  // refused it.
  //
  // adminController cannot be require()d here — it pulls in node-fetch, which
  // is ESM and stops this whole suite from loading — so the rules are read
  // from its source, the same way the Dart files are read below.
  const fs = require('fs');
  const path = require('path');
  const read = (...p) => {
    const f = path.join(__dirname, ...p);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
  };

  const server = read('..', 'controllers', 'adminController.js');

  test('the server demands a reason AND feedback on a rejection', () => {
    expect(server).toContain("return res.status(400).json({ error: 'Please select a rejection reason.' });");
    expect(server).toContain("return res.status(400).json({ error: 'Please provide feedback for the rejection.' });");
  });

  test('the server demands send-back remarks of 5..2000 characters', () => {
    expect(server).toContain('if (!remarks || remarks.length < 5)');
    expect(server).toContain('if (remarks.length > 2000)');
  });

  test('the app asks for all of that BEFORE it queues anything', () => {
    const src = read('..', '..', 'state_incharge', 'lib', 'screens', 'sheets.dart');
    if (!src) return;   // the Flutter source is not deployed to the server

    // Reject stays disabled until there is both a reason and feedback.
    expect(src).toContain('_chosen != null && _note.text.trim().isNotEmpty');
    // The same 5..2000 window.
    expect(src).toContain('length >= 5 && length <= 2000');
    // The six reasons, worded exactly as the dashboard words them, so a
    // reporter gets identical feedback whichever way it was rejected. The
    // reason is free text to the server, so the DASHBOARD's own page is the
    // only place the wording is defined — that is what is compared here.
    const page = read('..', 'views', 'pending-news.ejs');
    ['Factually Inaccurate', 'Inappropriate Content', 'Poor Quality',
      'Plagiarism', 'Missing Attribution', 'Incomplete Article']
      .forEach((r) => {
        expect(src).toContain(r);
        expect(page).toContain(`selectReason('${r}')`);
      });
  });
});

describe('the duplicate comparison the app shows', () => {
  const incharge = { _id: 'i1', role: 'subeditor', displayRole: 'Bureau', isActive: true, permissions: { canApproveNews: true } };
  const ID = '507f1f77bcf86cd799439011';
  const findOne = (doc) => ({ select: () => ({ lean: () => Promise.resolve(doc) }) });

  test('it is scoped like the queue, and reads nothing when it is not yours', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    News.findOne = jest.fn().mockReturnValue(findOne(null));
    const res = mockRes();
    await ctrl.newsDuplicates({ admin: { id: 'i1' }, params: { id: ID } }, res);

    const q = News.findOne.mock.calls[0][0];
    expect(q._id).toBe(ID);
    expect(q.scopedFor).toBe('this-incharge');
    expect(res.code).toBe(404);
  });

  test('it never writes — a phone tap must not re-run the duplicate engine', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    News.findOne = jest.fn().mockReturnValue(findOne({
      _id: ID, title: 'T', content: 'c', language: 'te',
      duplicateCheck: { score: 91, reasonLabel: 'Same image', similarArticles: [] },
    }));
    News.findByIdAndUpdate = jest.fn();
    const res = mockRes();
    await ctrl.newsDuplicates({ admin: { id: 'i1' }, params: { id: ID } }, res);

    expect(res.code).toBe(200);
    expect(News.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(res.body.score).toBe(91);
    expect(res.body.reasonLabel).toBe('Same image');
    expect(res.body.matches).toEqual([]);
  });

  test('same-language only: BOTH a cross-language image and text match are dropped', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    News.findOne = jest.fn().mockReturnValue(findOne({
      _id: ID, title: 'T', content: 'c', language: 'te',
      duplicateCheck: {
        score: 90, reasonLabel: 'Image', isSuspicious: true,
        similarArticles: [
          { articleId: '507f1f77bcf86cd799439aa1', matchSource: 'image', similarity: { overall: 90 } },
          { articleId: '507f1f77bcf86cd799439bb2', matchSource: 'content', similarity: { overall: 88 } },
        ],
      },
    }));
    // Both matched articles are in Hindi (the same photo was reused on a Hindi story).
    News.find = jest.fn().mockReturnValue({ select: () => ({ lean: async () => [
      { _id: '507f1f77bcf86cd799439aa1', title: 'Hindi photo story', content: 'x', language: 'hi', isActive: true },
      { _id: '507f1f77bcf86cd799439bb2', title: 'Hindi text story', content: 'y', language: 'hi', isActive: true },
    ] }) });
    const res = mockRes();
    await ctrl.newsDuplicates({ admin: { id: 'i1' }, params: { id: ID } }, res);
    expect(res.code).toBe(200);
    const ids = res.body.matches.map((m) => m.id);
    // Owner's rule: same-language only. The Telugu desk sees neither the Hindi
    // image reuse nor the Hindi text — both are different-language, so dropped.
    expect(ids).not.toContain('507f1f77bcf86cd799439aa1');
    expect(ids).not.toContain('507f1f77bcf86cd799439bb2');
  });

  test('a same-language image AND text match are both kept', async () => {
    Admin.findById.mockReturnValue(lean(incharge));
    News.findOne = jest.fn().mockReturnValue(findOne({
      _id: ID, title: 'T', content: 'c', language: 'te',
      duplicateCheck: {
        score: 90, reasonLabel: 'Image', isSuspicious: true,
        similarArticles: [
          { articleId: '507f1f77bcf86cd799439aa1', matchSource: 'image', similarity: { overall: 90 } },
          { articleId: '507f1f77bcf86cd799439bb2', matchSource: 'content', similarity: { overall: 88 } },
        ],
      },
    }));
    News.find = jest.fn().mockReturnValue({ select: () => ({ lean: async () => [
      { _id: '507f1f77bcf86cd799439aa1', title: 'Telugu photo story', content: 'x', language: 'te', isActive: true },
      { _id: '507f1f77bcf86cd799439bb2', title: 'Telugu text story', content: 'y', language: 'te', isActive: true },
    ] }) });
    const res = mockRes();
    await ctrl.newsDuplicates({ admin: { id: 'i1' }, params: { id: ID } }, res);
    expect(res.code).toBe(200);
    const ids = res.body.matches.map((m) => m.id);
    expect(ids).toContain('507f1f77bcf86cd799439aa1');
    expect(ids).toContain('507f1f77bcf86cd799439bb2');
  });

  test('a bad id and a reporter are both refused before any read', async () => {
    Admin.findById.mockClear();
    const bad = mockRes();
    await ctrl.newsDuplicates({ admin: { id: 'i1' }, params: { id: 'nope' } }, bad);
    expect(bad.code).toBe(400);
    expect(Admin.findById).not.toHaveBeenCalled();

    Admin.findById.mockReturnValue(lean({ _id: 'r1', role: 'editor', displayRole: 'Staff Reporter', isActive: true }));
    News.findOne = jest.fn();
    const res = mockRes();
    await ctrl.newsDuplicates({ admin: { id: 'r1' }, params: { id: ID } }, res);
    expect(res.code).toBe(403);
    expect(News.findOne).not.toHaveBeenCalled();
  });
});

describe('the category and location lists an edit chooses from', () => {
  const Category = require('../models/Category');
  const Location = require('../models/Location');
  const chain = (rows) => ({ select: () => ({ sort: () => ({ lean: () => Promise.resolve(rows) }) }) });

  beforeEach(() => {
    ctrl._test.resetListsCache();
    Category.find = jest.fn().mockReturnValue(chain([{ name: 'News' }, { name: 'Sports' }, { name: 'News' }]));
    Location.find = jest.fn().mockReturnValue(chain([
      { name: 'Telangana', type: 'state' },
      { name: 'Karimnagar', type: 'district', parentName: 'Telangana' },
      { name: '  ' },
    ]));
  });

  test('names come from the real collections, de-duplicated and blank-free', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'i1', role: 'subeditor', isActive: true }));
    const res = mockRes();
    await ctrl.lists({ admin: { id: 'i1' } }, res);

    expect(res.body.categories).toEqual(['News', 'Sports']);
    expect(res.body.locations.map((l) => l.name)).toEqual(['Telangana', 'Karimnagar']);
  });

  test('program categories are left out — they are not news categories', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'i1', role: 'subeditor', isActive: true }));
    await ctrl.lists({ admin: { id: 'i1' } }, mockRes());
    expect(Category.find.mock.calls[0][0]).toEqual({ type: { $ne: 'program' } });
  });

  test('the lists are cached — every edit must not re-read two collections', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'i1', role: 'subeditor', isActive: true }));
    await ctrl.lists({ admin: { id: 'i1' } }, mockRes());
    await ctrl.lists({ admin: { id: 'i1' } }, mockRes());
    expect(Category.find).toHaveBeenCalledTimes(1);
  });

  test('a reporter is refused', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'r1', role: 'editor', displayRole: 'Staff Reporter', isActive: true }));
    const res = mockRes();
    await ctrl.lists({ admin: { id: 'r1' } }, res);
    expect(res.code).toBe(403);
  });
});

describe('the working-language filter the dashboard applies by default', () => {
  // The bug this pins: a Telangana Bureau (workingLanguage 'te') opened the app
  // and saw 168 items — Hindi, Punjabi, Tamil, Gujarati — where their own web
  // page showed 29. renderPendingNewsPage defaults a Sub-Editor's view to their
  // workingLanguage and the app was not doing it, so the two disagreed.
  const { languageFor } = ctrl._test;

  test('a Sub-Editor defaults to their own working language', () => {
    expect(languageFor({ role: 'subeditor', workingLanguage: 'te' }, undefined)).toBe('te');
    expect(languageFor({ role: 'subeditor', workingLanguage: 'hi' }, undefined)).toBe('hi');
  });

  test('"all" clears it, the same word the web dropdown uses', () => {
    expect(languageFor({ role: 'subeditor', workingLanguage: 'te' }, 'all')).toBe('');
  });

  test('an explicit choice wins over the default', () => {
    expect(languageFor({ role: 'subeditor', workingLanguage: 'te' }, 'hi')).toBe('hi');
  });

  test('admins are not filtered — they oversee every language', () => {
    expect(languageFor({ role: 'admin', workingLanguage: 'te' }, undefined)).toBe('');
    expect(languageFor({ role: 'superadmin' }, undefined)).toBe('');
  });

  test('a Sub-Editor with no working language set sees everything', () => {
    expect(languageFor({ role: 'subeditor' }, undefined)).toBe('');
    expect(languageFor({ role: 'subeditor', workingLanguage: '' }, undefined)).toBe('');
  });

  test('the rule matches renderPendingNewsPage line for line', () => {
    // Read from the dashboard controller rather than trusted from memory.
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'controllers', 'adminController.js'), 'utf8');
    expect(src).toContain("if (adminDoc?.role === 'subeditor' && adminDoc?.workingLanguage)");
    expect(src).toContain("selectedLanguage = adminDoc.workingLanguage;");
    expect(src).toContain("} else if (req.query.language === 'all') {");
  });

  test('the queue and the ALARM are filtered the same way', async () => {
    // If they diverged, a phone would ring at 30 minutes for news its owner
    // cannot see — the worst possible version of this bug.
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'controllers', 'inchargeAppController.js'), 'utf8');
    // oldestPendingMinutes (the alarm) and monitor both take the default.
    // All three read the ONE shared clock (queueFigures), which applies the
    // default working language through pendingQueryFor.
    expect(src).toContain('const f = await queueFigures(adminDoc, selfId);');
    expect(src).toContain('const f = await queueFigures(person, String(person._id));');
    expect(src).toContain('queueFigures(doc, me),');
    expect(src).toMatch(/async function queueFigures\(adminDoc, selfId\) \{\n  const q = await pendingQueryFor\(adminDoc, selfId\);/);
    // Reading ONE item deliberately does not filter by language.
    expect(src.match(/pendingQueryFor\(adminDoc, req\.admin\.id, \{ language: 'all' \}\)/g))
      .toHaveLength(2);
  });
});

describe('the menu — the same options as news.tehelkanews.in', () => {
  const { canSeeMenu, menuFor, isStateIncharge, MENU } = ctrl._test;

  test('the rule is the sidebar\'s own, copied exactly', () => {
    const fs = require('fs');
    const page = fs.readFileSync(
      require('path').join(__dirname, '..', 'views', 'partials', 'sidebar.ejs'), 'utf8');
    // If the web rule is ever relaxed or tightened, this fails and the copy
    // below has to be revisited rather than silently drifting.
    expect(page).toContain("if (admin.role !== 'subeditor') return true;");
    expect(page).toContain("return menu === 'zodiac' ? false : true;");
    expect(page).toContain("return admin.permissions.sidebar.zodiac === true;");
    expect(page).toContain("return admin.permissions.sidebar[menu] !== false;");
  });

  test('every menu key this app offers really exists in the sidebar', () => {
    const fs = require('fs');
    const page = fs.readFileSync(
      require('path').join(__dirname, '..', 'views', 'partials', 'sidebar.ejs'), 'utf8');
    for (const item of MENU) {
      if (item.key === 'dashboard' || item.key === 'pendingNews') continue; // both exist, checked below
      if (item.key === 'sendNotification') {
        // Not a switch: the web shows it to admins and canSendNotifications.
        expect(page).toContain("admin.permissions && admin.permissions.canSendNotifications");
        expect(page).toContain('href="/admin/notifications"');
        continue;
      }
      expect(page).toContain(`canView('${item.key}')`);
    }
    expect(page).toContain("canView('dashboard')");
    expect(page).toContain("canView('pendingNews')");
  });

  test('an unset flag means VISIBLE — nobody loses a menu entry by default', () => {
    const plain = { role: 'subeditor', permissions: {} };
    expect(canSeeMenu(plain, 'pendingNews')).toBe(true);
    expect(canSeeMenu(plain, 'addNews')).toBe(true);
    // ...except zodiac, which is opt-in on the web too.
    expect(canSeeMenu(plain, 'zodiac')).toBe(false);
  });

  test('a flag explicitly set to false hides it, here as on the web', () => {
    const doc = { role: 'subeditor', permissions: { sidebar: { addNews: false, polls: false, zodiac: true } } };
    expect(canSeeMenu(doc, 'addNews')).toBe(false);
    expect(canSeeMenu(doc, 'polls')).toBe(false);
    expect(canSeeMenu(doc, 'zodiac')).toBe(true);
    expect(canSeeMenu(doc, 'newsList')).toBe(true);
  });

  test('admins see everything', () => {
    for (const key of MENU.map((m) => m.key)) {
      expect(canSeeMenu({ role: 'admin' }, key)).toBe(true);
      expect(canSeeMenu({ role: 'superadmin' }, key)).toBe(true);
    }
  });

  test('"Assign reporters" needs a state, exactly as the sidebar requires', () => {
    expect(isStateIncharge({ displayRole: 'State In-Charge' })).toBe(true);
    expect(isStateIncharge({ assignedStates: ['Telangana'] })).toBe(true);
    expect(isStateIncharge({ assignedState: 'Bihar' })).toBe(true);
    expect(isStateIncharge({ displayRole: 'Bureau' })).toBe(false);

    const noState = { role: 'subeditor', displayRole: 'Bureau', permissions: {} };
    expect(menuFor(noState).some((m) => m.key === 'assignReporters')).toBe(false);
    const withState = { ...noState, assignedStates: ['Telangana'] };
    expect(menuFor(withState).some((m) => m.key === 'assignReporters')).toBe(true);
  });

  test('a hidden web section is hidden in the app too', () => {
    const doc = {
      role: 'subeditor', displayRole: 'Bureau',
      permissions: { sidebar: { polls: false, viralVideos: false, reports: false } },
    };
    const keys = menuFor(doc).map((m) => m.key);
    expect(keys).not.toContain('polls');
    expect(keys).not.toContain('viralVideos');
    expect(keys).not.toContain('reports');
    expect(keys).toContain('pendingNews');
  });

  test('each entry says whether the app can open it, and where it lives', () => {
    // A State In-Charge with a state and nothing switched off: the fullest
    // menu a Sub-Editor can have. (Assign Reporters lives inside the web
    // sidebar's subeditor-only block, so an admin fixture would not show it.)
    const keys = menuFor({ role: 'subeditor', displayRole: 'State In-Charge', assignedStates: ['Telangana'], permissions: { sidebar: { zodiac: true } } });
    for (const m of keys) {
      expect(typeof m.inApp).toBe('boolean');
      expect(typeof m.label).toBe('string');
      expect(m.label.length).toBeGreaterThan(2);
      // Anything the app cannot open must carry a web path, or the menu entry
      // would be a dead end.
      if (!m.inApp) expect(m.path).toMatch(/^\//);
    }
    // The eight sections real Sub-Editors actually have (29–30 of 31 each)
    // open in the app; the rest stay web-only and are simply listed.
    expect(keys.filter((m) => m.inApp).map((m) => m.key).sort()).toEqual([
      'addNews', 'assignReporters', 'coverageMap', 'dashboard', 'newsList',
      'pendingNews', 'plagiarismReport', 'rejectedNews', 'reporterAccess', 'viralVideos',
    ]);
  });

  test('/me carries the menu and where the website is', async () => {
    Admin.findById.mockReturnValue(lean({
      _id: 'i1', role: 'subeditor', displayRole: 'Bureau', name: 'Raju', isActive: true,
      assignedStates: ['Telangana'],
      permissions: { canApproveNews: true, sidebar: { zodiac: false, polls: false } },
    }));
    const res = mockRes();
    await ctrl.me({ admin: { id: 'i1' }, protocol: 'https', get: () => 'www.news.tehelkanews.in' }, res);

    expect(res.code).toBe(200);
    const keys = res.body.menu.map((m) => m.key);
    expect(keys).toContain('pendingNews');
    expect(keys).toContain('assignReporters');   // has a state
    expect(keys).not.toContain('polls');          // switched off
    expect(keys).not.toContain('zodiac');
    expect(res.body.webBase).toBe('https://www.news.tehelkanews.in');
  });
});

describe('what is assigned to me', () => {
  test('approval coverage and POSTING areas are reported separately', async () => {
    // Confusing the two is how "why do I not see that district" starts: the
    // assigned* fields say where someone may post, permissions.managed* says
    // whose news they approve, and only the latter builds the queue.
    Admin.findById.mockReturnValue(lean({
      _id: 'i1', role: 'subeditor', displayRole: 'Bureau', name: 'Raju', isActive: true,
      workingLanguage: 'te',
      assignedState: 'Telangana',
      assignedDistricts: ['Hyderabad'],
      permissions: {
        canApproveNews: true, approvalScope: 'geography',
        managedStates: [], managedDistricts: ['Karimnagar', 'Nizamabad', 'Karimnagar'],
        managedConstituencies: ['Sircilla'], managedLocations: [], managedReporterIds: [],
      },
    }));
    Admin.find.mockReturnValue({
      select: () => ({ lean: async () => [{ _id: 'r1', assignedDistricts: ['Karimnagar'] }] }),
    });
    const res = mockRes();
    await ctrl.coverage({ admin: { id: 'i1' } }, res);

    expect(res.code).toBe(200);
    expect(res.body.districts).toEqual(['Karimnagar', 'Nizamabad']);  // de-duplicated
    expect(res.body.constituencies).toEqual(['Sircilla']);
    expect(res.body.postingStates).toEqual(['Telangana']);
    expect(res.body.postingDistricts).toEqual(['Hyderabad']);
    expect(res.body.approvalScope).toBe('geography');
  });

  test('someone with no districts is shown an honest empty coverage', async () => {
    // Several real accounts are in this state, which is exactly why their
    // queue is always empty. They should be able to see that themselves.
    Admin.findById.mockReturnValue(lean({
      _id: 'i1', role: 'subeditor', displayRole: 'Sub Editor', isActive: true,
      permissions: { approvalScope: 'geography', managedDistricts: [], managedStates: [] },
    }));
    Admin.find.mockReturnValue({ select: () => ({ lean: async () => [] }) });
    const res = mockRes();
    await ctrl.coverage({ admin: { id: 'i1' } }, res);

    expect(res.body.districts).toEqual([]);
    expect(res.body.reporterCount).toBe(0);
    expect(res.body.canApprove).toBe(false);
  });

  test('a reporter cannot ask', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'r1', role: 'editor', displayRole: 'Staff Reporter', isActive: true }));
    const res = mockRes();
    await ctrl.coverage({ admin: { id: 'r1' } }, res);
    expect(res.code).toBe(403);
  });
});

describe('my own work report', () => {
  const mongoose = require('mongoose');
  const me = { _id: 'i1', role: 'subeditor', displayRole: 'Bureau', isActive: true, permissions: { canApproveNews: true } };
  const hoursAgo = (h) => new Date(Date.now() - h * 3600e3);
  /** An ObjectId minted at a given moment — i.e. an article FILED then. */
  const filedHoursAgo = (h) => mongoose.Types.ObjectId.createFromTime(Math.floor(hoursAgo(h).getTime() / 1000));
  let lastQuery;
  const rows = (list) => ({ select: () => ({ lean: async () => list }) });

  beforeEach(() => {
    Admin.findById.mockReturnValue(lean(me));
    // getManagedReporterIds — a team of one reporter.
    Admin.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'r1', assignedDistricts: ['Karimnagar'] }] }) });
    ctrl._test.resetAnalyticsCache();
  });

  const run = async (list, days) => {
    News.find.mockImplementation((q) => { lastQuery = q; return rows(list); });
    const res = mockRes();
    await ctrl.myWork({ admin: { id: 'i1' }, query: { days } }, res);
    return res;
  };

  test('only MY actions inside the window are counted', async () => {
    const res = await run([
      { _id: filedHoursAgo(3), actionHistory: [
        { action: 'approved', performedById: 'i1', performedAt: hoursAgo(0.5) },
        { action: 'approved', performedById: 'someone', performedAt: hoursAgo(0.5) },
      ] },
      { _id: filedHoursAgo(300), actionHistory: [
        { action: 'approved', performedById: 'i1', performedAt: hoursAgo(290) },   // outside 7 days
      ] },
      { _id: filedHoursAgo(5), actionHistory: [
        { action: 'rejected', performedById: 'i1', performedAt: hoursAgo(0.4) },
        { action: 'needs_revision', performedById: 'i1', performedAt: hoursAgo(0.3) },
        { action: 'updated', performedById: 'i1', performedAt: hoursAgo(0.3) },
      ] },
    ], 7);
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ approved: 1, rejected: 1, sentBack: 1, edited: 1, days: 7, capped: false });
    expect(res.body.total).toBe(3);   // an edit is not a decision
  });

  test('REGRESSION: the wait is measured from FILING, not from publishedAt', async () => {
    // approveNews overwrites publishedAt with the approval moment. The first
    // version measured from publishedAt and reported an average wait of 0
    // minutes for 284 approvals. The ObjectId keeps the real filing time.
    const approvedAt = hoursAgo(0.2);
    const res = await run([
      { _id: filedHoursAgo(1.2), publishedAt: approvedAt,                       // reset by approval
        actionHistory: [{ action: 'approved', performedById: 'i1', performedAt: approvedAt }] },
      { _id: filedHoursAgo(3.2), publishedAt: hoursAgo(0.2),
        actionHistory: [{ action: 'approved', performedById: 'i1', performedAt: hoursAgo(0.2) }] },
    ], 7);
    // 60 and 180 minutes → average 120, median 180 (upper middle), slowest 180.
    expect(res.body.averageMinutes).toBe(120);
    expect(res.body.slowestMinutes).toBe(180);
    expect(res.body.averageMinutes).not.toBe(0);
  });

  test('the filter runs IN the database — no arbitrary cap, no scanning everyone', async () => {
    await run([], 7);
    const q = JSON.stringify(lastQuery);
    expect(q).toContain('"performedById":"i1"');       // only my documents travel
    expect(q).toContain('"publishedAt"');               // approvals (publishedAt reset) branch
    expect(q).toContain('"authorId":{"$in":["r1","i1"]}'); // team branch for rejects/send-backs
  });

  test('"7 days" is seven whole IST days — the same window as the analytics home', async () => {
    await run([], 7);
    const since = new Date(JSON.stringify(lastQuery).match(/"performedAt":\{"\$gte":"([^"]+)"/)[1]);
    expect(since.getTime()).toBe(ctrl._test.istMidnight(6).getTime());
  });

  test('"today" is the Indian calendar day, not the last 24 hours', async () => {
    await run([], 1);
    const since = new Date(JSON.stringify(lastQuery).match(/"performedAt":\{"\$gte":"([^"]+)"/)[1]);
    const ist = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(since);
    expect(ist).toBe('00:00');
  });

  test('the window is bounded — a phone cannot ask for a year', async () => {
    for (const [asked, got] of [[365, 31], [0, 1], [-5, 1], ['abc', 1], [7, 7]]) {
      const res = await run([], asked);
      expect(res.body.days).toBe(got);
    }
  });

  test('a reporter cannot ask', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'r1', role: 'editor', displayRole: 'Staff Reporter', isActive: true }));
    News.find.mockClear();
    const res = mockRes();
    await ctrl.myWork({ admin: { id: 'r1' }, query: {} }, res);
    expect(res.code).toBe(403);
    expect(News.find).not.toHaveBeenCalled();
  });
});

describe('the analytics scope, copied from the dashboard', () => {
  const { analyticsScopeFor } = ctrl._test;

  test('the copy still matches adminController.buildAnalyticsScopeFilter line for line', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'controllers', 'adminController.js'), 'utf8');
    const start = src.indexOf('async function buildAnalyticsScopeFilter');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    // Every branch the original has, the copy has — checked against the
    // original's own text, so a change on the web side fails here.
    expect(body).toContain("if (role === 'superadmin' || role === 'admin') return {};");
    expect(body).toContain("if (role === 'editor') return { authorId: selfId };");
    expect(body).toContain("if (perms.canViewAllNews) return {};");
    expect(body).toContain("const orClauses = [{ authorId: selfId }];");
    expect(body).toContain("orClauses.push({ authorId: { $in: reporterIds } });");
  });

  test('a Bureau sees their own plus their reporters, nothing else', async () => {
    buildPendingNewsFilterForSubEditor.mockClear();
    Admin.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'r1', assignedDistricts: ['Karimnagar'] }] }) });
    const scope = await analyticsScopeFor({
      _id: 'i1', role: 'subeditor',
      permissions: { approvalScope: 'geography', managedDistricts: ['Karimnagar'] },
    });
    expect(scope.$or[0]).toEqual({ authorId: 'i1' });
    expect(scope.$or[1]).toEqual({ authorId: { $in: ['r1'] } });
  });

  test('admins are unscoped; a reporter is pinned to themselves', async () => {
    expect(await analyticsScopeFor({ _id: 'a', role: 'admin' })).toEqual({});
    expect(await analyticsScopeFor({ _id: 'r', role: 'editor' })).toEqual({ authorId: 'r' });
  });
});

describe('the News List, as the app gets it', () => {
  const chain = (rows) => ({ select: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => rows }) }) }) }) });
  const bureau = {
    _id: 'i1', role: 'subeditor', displayRole: 'Bureau', isActive: true,
    permissions: { canApproveNews: true, canEditNews: false, approvalScope: 'geography', managedDistricts: ['Karimnagar'] },
  };

  beforeEach(() => {
    Admin.findById.mockReturnValue(lean(bureau));
    Admin.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'r1', assignedDistricts: ['Karimnagar'] }] }) });
    News.countDocuments.mockResolvedValue(3);
  });

  test('the team tab is scoped to managed reporters, exactly like the web page', async () => {
    News.find.mockReturnValue(chain([]));
    const res = mockRes();
    await ctrl.newsList({ admin: { id: 'i1' }, query: { tab: 'team-list' } }, res);
    expect(res.code).toBe(200);
    expect(res.body.tab).toBe('team-list');
    expect(res.body.hasTeamScope).toBe(true);
    expect(JSON.stringify(News.find.mock.calls[0][0])).toContain('"$in":["r1"]');
  });

  test('"my articles" is pinned to the caller', async () => {
    News.find.mockReturnValue(chain([]));
    await ctrl.newsList({ admin: { id: 'i1' }, query: { tab: 'my-list' } }, mockRes());
    expect(JSON.stringify(News.find.mock.calls[0][0])).toContain('"authorId":"i1"');
  });

  test('status filters carry the web page\'s exact meanings', async () => {
    for (const [status, expectPart] of [
      ['active', '"isActive":true'],
      ['inactive', '"isDeactivated":true'],
      ['pending', '"isDeactivated":{"$ne":true}'],
      ['rejected', '"rejectionStatus.isRejected":true'],
    ]) {
      News.find.mockReturnValue(chain([]));
      await ctrl.newsList({ admin: { id: 'i1' }, query: { tab: 'my-list', status } }, mockRes());
      expect(JSON.stringify(News.find.mock.calls.pop()[0])).toContain(expectPart);
    }
  });

  test('the Edit button follows the web rule: own-and-not-rejected, or canEditNews', async () => {
    News.find.mockReturnValue(chain([
      { _id: 'n1', authorId: 'i1', isActive: true, publishedAt: new Date() },                    // own
      { _id: 'n2', authorId: 'r1', isActive: true, publishedAt: new Date() },                    // team
      { _id: 'n3', authorId: 'i1', isActive: false, rejectionStatus: { isRejected: true }, publishedAt: new Date() }, // own but rejected
    ]));
    const res = mockRes();
    await ctrl.newsList({ admin: { id: 'i1' }, query: { tab: 'my-list' } }, res);
    expect(res.body.news.map((n) => n.canEdit)).toEqual([true, false, false]);

    // With canEditNews everything becomes editable, as on the web.
    Admin.findById.mockReturnValue(lean({ ...bureau, permissions: { ...bureau.permissions, canEditNews: true } }));
    News.find.mockReturnValue(chain([{ _id: 'n2', authorId: 'r1', isActive: true, publishedAt: new Date() }]));
    const res2 = mockRes();
    await ctrl.newsList({ admin: { id: 'i1' }, query: { tab: 'team-list' } }, res2);
    expect(res2.body.news[0].canEdit).toBe(true);
  });

  test('a row carries the four statuses the web list shows', () => {
    const { newsCard } = ctrl._test;
    expect(newsCard({ _id: 'a', isActive: true }).status).toBe('active');
    expect(newsCard({ _id: 'b', isActive: false, isDeactivated: true }).status).toBe('inactive');
    expect(newsCard({ _id: 'c', isActive: false }).status).toBe('pending');
    expect(newsCard({ _id: 'd', isActive: false, rejectionStatus: { isRejected: true, reason: 'Poor Quality', feedback: 'blurry' } }).status).toBe('rejected');
    expect(newsCard({ _id: 'd', rejectionStatus: { isRejected: true, reason: 'Poor Quality', feedback: 'blurry' } }).rejection)
      .toMatchObject({ reason: 'Poor Quality', feedback: 'blurry' });
  });

  test('a reporter is refused', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'r1', role: 'editor', displayRole: 'Staff Reporter', isActive: true }));
    const res = mockRes();
    await ctrl.newsList({ admin: { id: 'r1' }, query: {} }, res);
    expect(res.code).toBe(403);
  });
});

describe('Rejected News and the Plagiarism Report', () => {
  const chain = (rows) => ({ select: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => rows }) }) }) }) });
  const plain = (rows) => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => rows }) }) }) });
  const bureau = { _id: 'i1', role: 'subeditor', displayRole: 'Bureau', isActive: true, permissions: { approvalScope: 'geography', managedDistricts: ['Karimnagar'] } };

  beforeEach(() => {
    Admin.findById.mockReturnValue(lean(bureau));
    Admin.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'r1', assignedDistricts: ['Karimnagar'] }] }) });
    News.countDocuments.mockResolvedValue(0);
  });

  test('rejected news is scoped to own + reporters and carries the reason given', async () => {
    News.find.mockReturnValue(chain([{
      _id: 'n1', authorId: 'r1', publishedAt: new Date(),
      rejectionStatus: { isRejected: true, reason: 'Plagiarism', feedback: 'copied from X', rejectedBy: 'Raju' },
    }]));
    const res = mockRes();
    await ctrl.rejected({ admin: { id: 'i1' }, query: {} }, res);
    const q = JSON.stringify(News.find.mock.calls[0][0]);
    expect(q).toContain('"rejectionStatus.isRejected":true');
    expect(q).toContain('"authorId":"i1"');
    expect(q).toContain('"$in":["r1"]');
    expect(res.body.news[0].rejection).toMatchObject({ reason: 'Plagiarism', feedback: 'copied from X', by: 'Raju' });
  });

  test('the plagiarism report is scoped and never uses the unscoped web route', async () => {
    News.find.mockReturnValue(plain([{
      _id: 'n1', authorId: 'r1', publishedAt: new Date(), isActive: true,
      duplicateCheck: { isDuplicate: true, score: 93, reasonLabel: 'Same image', similarArticles: [{ articleTitle: 'Other', similarity: { overall: 93 } }] },
    }]));
    const res = mockRes();
    await ctrl.plagiarism({ admin: { id: 'i1' }, query: {} }, res);
    const q = JSON.stringify(News.find.mock.calls[0][0]);
    expect(q).toContain('"authorId":"i1"');                 // scoped
    expect(q).toContain('duplicateCheck.isDuplicate');
    expect(res.body.duplicates).toBe(1);
    expect(res.body.news[0]).toMatchObject({ verdict: 'duplicate', score: 93, reasonLabel: 'Same image', matchCount: 1 });
    expect(res.body.news[0].matches[0].title).toBe('Other');

    // The unscoped web route the app deliberately never requests. Checked in
    // the app's API layer, where a call would actually live; the controller
    // merely mentions it in a comment explaining why it is avoided.
    const fs = require('fs');
    const api = require('path').join(__dirname, '..', '..', 'state_incharge', 'lib', 'services', 'api.dart');
    if (fs.existsSync(api)) expect(fs.readFileSync(api, 'utf8')).not.toContain('duplicate-details');
    expect(Object.keys(ctrl)).toContain('plagiarism');   // the scoped route exists instead
  });
});

describe('what the Add / Edit News form is allowed to offer', () => {
  test('languages, scopes, posting areas and the source-link rule are the person\'s own', async () => {
    Admin.findById.mockReturnValue(lean({
      _id: 'i1', role: 'subeditor', displayRole: 'Bureau', isActive: true,
      workingLanguage: 'te', allowedLanguages: ['te', 'hi'], allowedScopes: ['state', 'district'],
      assignedStates: ['Telangana'], assignedDistricts: ['Karimnagar'],
      permissions: { requiresSourceLink: true, aiCheckEnabled: false },
    }));
    const Category = require('../models/Category');
    const Location = require('../models/Location');
    Category.find = jest.fn().mockReturnValue({ select: () => ({ sort: () => ({ lean: async () => [{ name: 'News' }] }) }) });
    Location.getHierarchy = jest.fn(async () => [{ name: 'Telangana', districts: [{ name: 'Karimnagar', constituencies: [{ name: 'Sircilla' }] }] }]);

    const res = mockRes();
    await ctrl.newsForm({ admin: { id: 'i1' } }, res);
    expect(res.code).toBe(200);
    expect(res.body.allowedScopes).toEqual(['state', 'district']);
    expect(res.body.postingStates).toEqual(['Telangana']);
    expect(res.body.postingDistricts).toEqual(['Karimnagar']);
    expect(res.body.requiresSourceLink).toBe(true);
    expect(res.body.aiGate).toBe(false);          // switched off for this person
    expect(res.body.categories).toEqual(['News']);
    expect(res.body.states[0].districts[0].constituencies).toEqual(['Sircilla']);
    expect(res.body.defaultLanguage).toBe('te');
  });
});

describe('a scope can never be lost under a page\'s own $or', () => {
  const { withinScope } = ctrl._test;
  test('two $or conditions are AND-ed, not merged', () => {
    const scope = { $or: [{ authorId: 'i1' }, { authorId: { $in: ['r1'] } }] };
    const page = { $or: [{ 'duplicateCheck.isDuplicate': true }] };
    const q = withinScope(scope, page);
    expect(q.$and).toEqual([scope, page]);
    expect(q.$or).toBeUndefined();
  });
  test('an empty scope (admin) leaves the condition alone', () => {
    expect(withinScope({}, { a: 1 })).toEqual({ a: 1 });
    expect(withinScope(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});

describe('the analytics home', () => {
  const mongoose = require('mongoose');
  const bureau = {
    _id: 'i1', role: 'subeditor', displayRole: 'Bureau', isActive: true, workingLanguage: 'te',
    permissions: { canApproveNews: true, approvalScope: 'geography', managedDistricts: ['Karimnagar'] },
  };
  const minsAgo = (m) => new Date(Date.now() - m * 60e3);
  const oidMinsAgo = (m) => mongoose.Types.ObjectId.createFromTime(Math.floor(minsAgo(m).getTime() / 1000));
  let calls;

  beforeEach(() => {
    ctrl._test.resetAnalyticsCache();
    calls = { aggregate: [], find: [], distinct: [] };
    Admin.findById.mockReturnValue(lean(bureau));
    Admin.find.mockImplementation((q) => ({
      // getManagedReporterIds asks for every editor; the name lookup asks by id.
      select: () => ({ lean: async () => (q && q._id
        ? [{ _id: 'r1', name: 'Ravi', assignedDistricts: ['Karimnagar'] }, { _id: 'r2', name: 'Sita', assignedDistricts: ['Karimnagar'] }]
        : [{ _id: 'r1', assignedDistricts: ['Karimnagar'] }, { _id: 'r2', assignedDistricts: ['Karimnagar'] }]) }),
    }));
    News.aggregate = jest.fn(async (pipeline) => {
      calls.aggregate.push(pipeline);
      const m = pipeline[0].$match;
      if (pipeline[1] && pipeline[1].$facet) {
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
        return [{ perDay: [{ _id: today, n: 4 }], byCategory: [{ _id: 'News', n: 3 }, { _id: null, n: 1 }],
                  byLocation: [{ _id: 'Karimnagar', n: 4 }], byAuthor: [{ _id: 'r1', n: 4 }] }];
      }
      if (m && m['rejectionStatus.isRejected']) return [{ _id: 'Poor Quality', n: 2 }];
      return [{ total: 10, live: 6, pending: 2, hidden: 1, rejected: 1, views: 500 }];
    });
    News.distinct = jest.fn(async (field, q) => { calls.distinct.push(q); return ['r1']; });   // r2 filed nothing this week
    News.find.mockImplementation((q) => {
      calls.find.push(q);
      const isQueue = q && (q.scopedFor === 'this-incharge' || JSON.stringify(q).includes('"isActive":false'));
      const acted = JSON.stringify(q).includes('performedById');
      return {
        select: () => ({
          sort: () => ({ limit: () => ({ lean: async () => (isQueue ? [
            { publishedAt: minsAgo(5) }, { publishedAt: minsAgo(20) }, { publishedAt: minsAgo(35) }, { publishedAt: minsAgo(90) },
          ] : []) }) }),
          lean: async () => (acted ? [
            { _id: oidMinsAgo(70), actionHistory: [{ action: 'approved', performedById: 'i1', performedAt: minsAgo(10) }] },
          ] : []),
        }),
      };
    });
  });

  test('cards, series and breakdowns all come back, scoped to the team', async () => {
    const res = mockRes();
    await ctrl.analytics({ admin: { id: 'i1' }, query: { days: 7 } }, res);
    expect(res.code).toBe(200);
    const b = res.body;

    // Right now — the queue's own clock and buckets.
    expect(b.now).toMatchObject({ pending: 4, late: 2 });
    expect(b.pendingAges).toEqual({ under15: 1, from15to30: 1, from30to40: 1, over40: 1 });

    // Today — one approval, and the wait from FILING (70 − 10 = 60 minutes).
    expect(b.today.approved).toBe(1);
    expect(b.today.averageWait).toBe(60);
    expect(b.today.teamNews).toBe(4);

    // The web home's cards.
    expect(b.status).toMatchObject({ total: 10, live: 6, pending: 2, hidden: 1, rejected: 1, views: 500 });

    // Seven IST days, oldest first, today last.
    expect(b.series).toHaveLength(7);
    expect(b.series[6].teamNews).toBe(4);

    // Breakdowns, with blank categories dropped rather than shown as "null".
    expect(b.byCategory).toEqual([{ name: 'News', n: 3, placeholder: false }]);
    expect(b.topReporters[0]).toMatchObject({ id: 'r1', name: 'Ravi', n: 4 });
    expect(b.rejectReasons).toEqual([{ name: 'Poor Quality', n: 2, placeholder: false }]);

    // Sita filed nothing this week — the quiet list is the point of that card.
    expect(b.silentReporters).toMatchObject({ teamSize: 2, count: 1 });
    expect(b.silentReporters.sample[0]).toMatchObject({ id: 'r2', name: 'Sita' });
  });

  test('every team read is limited to the team\'s own authors', async () => {
    await ctrl.analytics({ admin: { id: 'i1' }, query: { days: 7 } }, mockRes());
    const facet = calls.aggregate.find((p) => p[1] && p[1].$facet);
    expect(facet[0].$match.authorId).toEqual({ $in: ['r1', 'r2'] });
    expect(facet[0].$match._id.$gte).toBeDefined();          // filed-in-range, by ObjectId
    const reject = calls.aggregate.find((p) => p[0].$match['rejectionStatus.isRejected']);
    expect(reject[0].$match.authorId).toEqual({ $in: ['r1', 'r2'] });
    expect(calls.distinct[0].authorId).toEqual({ $in: ['r1', 'r2'] });
  });

  test('"right now" uses the very query the queue and the alarm use', async () => {
    await ctrl.analytics({ admin: { id: 'i1' }, query: { days: 7 } }, mockRes());
    const queueRead = calls.find.find((q) => q.scopedFor === 'this-incharge');
    expect(queueRead).toBeDefined();
    // Working-language default included, exactly as the queue has it.
    expect(JSON.stringify(queueRead)).toContain('"language":"te"');
  });

  test('a repeat visit within three minutes is served from cache', async () => {
    await ctrl.analytics({ admin: { id: 'i1' }, query: { days: 7 } }, mockRes());
    const n = News.aggregate.mock.calls.length;
    await ctrl.analytics({ admin: { id: 'i1' }, query: { days: 7 } }, mockRes());
    expect(News.aggregate.mock.calls.length).toBe(n);
    // ...but a different range is its own question.
    await ctrl.analytics({ admin: { id: 'i1' }, query: { days: 30 } }, mockRes());
    expect(News.aggregate.mock.calls.length).toBeGreaterThan(n);
  });

  test('only 7 or 30 days are offered; anything else means 7', async () => {
    for (const [asked, got] of [[30, 30], [7, 7], [365, 7], ['x', 7], [undefined, 7]]) {
      ctrl._test.resetAnalyticsCache();
      const res = mockRes();
      await ctrl.analytics({ admin: { id: 'i1' }, query: { days: asked } }, res);
      expect(res.body.days).toBe(got);
    }
  });

  test('IST day list runs from the start of the range to today, inclusive', () => {
    const days = ctrl._test.istDaysSince(ctrl._test.istMidnight(6));
    expect(days).toHaveLength(7);
    expect(days[6]).toBe(ctrl._test.istDay(new Date()));
  });

  test('a reporter is refused', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'r1', role: 'editor', displayRole: 'Staff Reporter', isActive: true }));
    const res = mockRes();
    await ctrl.analytics({ admin: { id: 'r1' }, query: {} }, res);
    expect(res.code).toBe(403);
  });
});

describe('Send notification in the menu', () => {
  const { menuFor } = ctrl._test;
  test('appears only for canSendNotifications, as on the web', () => {
    const base = { role: 'subeditor', displayRole: 'Bureau', permissions: {} };
    expect(menuFor(base).some((m) => m.key === 'sendNotification')).toBe(false);
    expect(menuFor({ ...base, permissions: { canSendNotifications: true } }).some((m) => m.key === 'sendNotification')).toBe(true);
    expect(menuFor({ role: 'admin' }).some((m) => m.key === 'sendNotification')).toBe(true);
  });

  test('entries carry the web sidebar\'s headings, in the web\'s order', () => {
    const m = menuFor({ role: 'subeditor', displayRole: 'State In-Charge', assignedStates: ['Telangana'],
      permissions: { canSendNotifications: true, sidebar: { zodiac: true } } });
    const groups = [...new Set(m.map((x) => x.group))];
    expect(groups).toEqual(['Main', 'News & Content', 'Media', 'Categories & Regions', 'Reports', 'Tools']);
    expect(m.find((x) => x.key === 'addNews').group).toBe('News & Content');
    expect(m.find((x) => x.key === 'sendNotification').group).toBe('Tools');
  });
});

describe('a placeholder saved as a category is shown, and marked', () => {
  test('"Loading..." is flagged so the app can label it, not hidden', () => {
    const { isPlaceholderValue } = require('../utils/placeholderValue');
    expect(isPlaceholderValue('Loading...')).toBe(true);
    expect(isPlaceholderValue('Nandyal')).toBe(false);
  });
});

describe('one of my reporters, for the pop-up', () => {
  const mongoose = require('mongoose');
  const RID = '507f1f77bcf86cd799439022';
  const bureau = {
    _id: 'i1', role: 'subeditor', displayRole: 'Bureau', isActive: true,
    permissions: { approvalScope: 'geography', managedDistricts: ['Karimnagar'] },
  };
  const reporter = {
    _id: RID, name: 'Ravi', mobileNumber: '9876543210', email: 'ravi@x.in', reporterTier: 'stringer',
    assignedState: 'Telangana', assignedDistricts: ['Karimnagar'], assignedConstituencies: ['Sircilla'],
    isActive: true, createdAt: new Date('2026-01-01'), postedFrom: { ip: '1.2.3.4' },
  };
  let selected;

  beforeEach(() => {
    selected = '';
    Admin.findById.mockReturnValue(lean(bureau));
    // getManagedReporterIds sees RID in Karimnagar.
    Admin.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: RID, assignedDistricts: ['Karimnagar'] }] }) });
    Admin.findOne = jest.fn().mockReturnValue({ select: (f) => { selected = f; return { lean: async () => reporter }; } });
    News.aggregate = jest.fn(async () => [{ total: 40, today: 2, week: 9, live: 35, rejected: 3, pending: 2, lastId: mongoose.Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 3600) }]);
  });

  test('my own reporter: name, phone, tier, places and their news counts', async () => {
    const res = mockRes();
    await ctrl.reporterDetail({ admin: { id: 'i1' }, params: { id: RID } }, res);
    expect(res.code).toBe(200);
    expect(res.body.reporter).toMatchObject({
      name: 'Ravi', phone: '9876543210', tier: 'Stringer',
      states: ['Telangana'], districts: ['Karimnagar'], constituencies: ['Sircilla'],
      news: { today: 2, week: 9, total: 40, live: 35, pending: 2, rejected: 3 },
    });
    expect(res.body.reporter.lastFiledAt).toBeTruthy();
  });

  test('email only with "View reporter details", as on the web', async () => {
    const res = mockRes();
    await ctrl.reporterDetail({ admin: { id: 'i1' }, params: { id: RID } }, res);
    expect(res.body.reporter.email).toBe('');
    expect(res.body.reporter.emailHidden).toBe(true);

    Admin.findById.mockReturnValue(lean({ ...bureau, permissions: { ...bureau.permissions, canViewReporterDetails: true } }));
    const res2 = mockRes();
    await ctrl.reporterDetail({ admin: { id: 'i1' }, params: { id: RID } }, res2);
    expect(res2.body.reporter.email).toBe('ravi@x.in');
  });

  test('never reads postedFrom (phone / GPS / IP is Super Admin only)', async () => {
    await ctrl.reporterDetail({ admin: { id: 'i1' }, params: { id: RID } }, mockRes());
    expect(selected).not.toMatch(/postedFrom/);
  });

  test('someone else\'s reporter is a 404 — the id cannot browse the staff list', async () => {
    Admin.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'other', assignedDistricts: ['Karimnagar'] }] }) });
    const res = mockRes();
    await ctrl.reporterDetail({ admin: { id: 'i1' }, params: { id: RID } }, res);
    expect(res.code).toBe(404);
    expect(Admin.findOne).not.toHaveBeenCalled();
  });

  test('a bad id and a reporter caller are refused', async () => {
    const bad = mockRes();
    await ctrl.reporterDetail({ admin: { id: 'i1' }, params: { id: 'nope' } }, bad);
    expect(bad.code).toBe(400);
    Admin.findById.mockReturnValue(lean({ _id: 'r1', role: 'editor', displayRole: 'Staff Reporter', isActive: true }));
    const res = mockRes();
    await ctrl.reporterDetail({ admin: { id: 'r1' }, params: { id: RID } }, res);
    expect(res.code).toBe(403);
  });
});

describe('tags on each queue card — the web\'s own badge rules', () => {
  const mongoose = require('mongoose');
  const { duplicateBadge, queueClock, lateTypeOf, changedFieldsOf } = ctrl._test;
  const minsAgo = (m) => new Date(Date.now() - m * 60000);

  test('Duplicate / Similar only when flagged AND there is something to compare', () => {
    expect(duplicateBadge({ isDuplicate: true, score: 93, matchSource: 'image', similarArticles: [{}] }))
      .toMatchObject({ flagged: true, isDuplicate: true, score: 93, label: 'Image' });
    expect(duplicateBadge({ isSuspicious: true, score: 71, matchSource: 'content', similarArticles: [{}] }))
      .toMatchObject({ flagged: true, isDuplicate: false, label: 'Content' });
    expect(duplicateBadge({ isDuplicate: true, matchSource: 'both', similarArticles: [{}, {}] }).label).toBe('Image + Content');
    expect(duplicateBadge({ isDuplicate: true, reasonLabel: 'Same photo', similarArticles: [{}] }).label).toBe('Same photo');
    // Flagged with no matches — the web shows nothing, so neither do we.
    expect(duplicateBadge({ isDuplicate: true, score: 90, similarArticles: [] }).flagged).toBe(false);
    expect(duplicateBadge(undefined).flagged).toBe(false);
  });

  test('the web badge rules are the ones copied', () => {
    const page = require('fs').readFileSync(require('path').join(__dirname, '..', 'views', 'pending-news.ejs'), 'utf8');
    expect(page).toContain("const isResubmitted = !needsRevision && Number(rs?.revisionCount) > 0 && !!rs?.resubmittedAt;");
    expect(page).toContain("const label = dc.reasonLabel || (src === 'image' ? 'Image' : src === 'both' ? 'Image + Content' : 'Content');");
  });

  test('sent back → the reporter\'s turn; resent → clock from resubmission', () => {
    const sentBack = queueClock({ publishedAt: minsAgo(300), revisionStatus: { needsRevision: true } });
    expect(sentBack).toMatchObject({ waitingOnReporter: true, resent: false, minutes: 0 });
    const resent = queueClock({ publishedAt: minsAgo(180), revisionStatus: { revisionCount: 1, resubmittedAt: minsAgo(6) } });
    expect(resent).toMatchObject({ waitingOnReporter: false, resent: true, minutes: 6 });
    const plain = queueClock({ publishedAt: minsAgo(12) });
    expect(plain).toMatchObject({ waitingOnReporter: false, resent: false, minutes: 12 });
  });

  test('lateness is the server\'s own rule, from the FILING time', () => {
    const at = (m) => ({ _id: mongoose.Types.ObjectId.createFromTime(Math.floor(minsAgo(m).getTime() / 1000)) });
    expect(lateTypeOf(at(5))).toBe('on_time');
    expect(lateTypeOf(at(3 * 24 * 60))).toBe('day_late');
  });

  test('REGRESSION: lastChangeSummary is an object — we send field names, not "[object Object]"', () => {
    expect(changedFieldsOf({ lastChangeSummary: { round: 1, changedFields: ['title', 'content'], fields: {} } }))
      .toEqual(['title', 'content']);
    expect(changedFieldsOf({ lastChangeSummary: 'weird' })).toEqual([]);
    expect(changedFieldsOf(undefined)).toEqual([]);
  });

  test('the pending list carries every tag', async () => {
    Admin.findById.mockReturnValue(lean({ _id: 'i1', role: 'subeditor', displayRole: 'Bureau', isActive: true, permissions: {} }));
    const oid = mongoose.Types.ObjectId.createFromTime(Math.floor(minsAgo(3 * 24 * 60).getTime() / 1000));
    News.find.mockReturnValue({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [{
      _id: oid, title: 'T', category: 'Loading...', location: 'Nizamabad', authorId: 'r1', publishedAt: minsAgo(3 * 24 * 60),
      revisionStatus: { needsRevision: false, revisionCount: 2, resubmittedAt: minsAgo(3) },
      duplicateCheck: { isDuplicate: true, score: 93, matchSource: 'image', similarArticles: [{ articleId: 'x' }] },
    }] }) }) }) });
    Admin.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'r1', name: 'KALIDAS' }] }) });
    const res = mockRes();
    await ctrl.pending({ admin: { id: 'i1' }, query: {} }, res);
    const n = res.body.news[0];
    expect(n).toMatchObject({
      authorId: 'r1', authorName: 'KALIDAS', resent: true, waitingOnReporter: false, revisionCount: 2,
      lateType: 'day_late', noCategory: true, noLocation: false,
      duplicate: { flagged: true, isDuplicate: true, score: 93, label: 'Image' },
    });
    expect(new Date(n.waitingSince).getTime()).toBeGreaterThan(Date.now() - 4 * 60000);   // clock from resend
  });
});

describe('the reporter pop-up from a queue item', () => {
  const RID = '507f1f77bcf86cd799439033';
  beforeEach(() => {
    Admin.findById.mockReturnValue(lean({ _id: 'i1', role: 'subeditor', displayRole: 'Bureau', isActive: true, permissions: { approvalScope: 'geography', managedDistricts: ['Karimnagar'] } }));
    Admin.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'someone-else', assignedDistricts: ['Karimnagar'] }] }) });
    Admin.findOne = jest.fn().mockReturnValue({ select: () => ({ lean: async () => ({ _id: RID, name: 'Outsider', mobileNumber: '9', isActive: true }) }) });
    News.aggregate = jest.fn(async () => []);
  });

  test('an author outside the team list opens IF they have an item in my queue (location match)', async () => {
    News.exists.mockResolvedValue({ _id: 'n1' });
    const res = mockRes();
    await ctrl.reporterDetail({ admin: { id: 'i1' }, params: { id: RID } }, res);
    expect(res.code).toBe(200);
    expect(res.body.reporter.name).toBe('Outsider');
    // …and that check is scoped to my queue.
    const q = JSON.stringify(News.exists.mock.calls[0][0]);
    expect(q).toContain(`"authorId":"${RID}"`);
    expect(q).toContain('this-incharge');
  });

  test('otherwise still a 404', async () => {
    News.exists.mockResolvedValue(null);
    const res = mockRes();
    await ctrl.reporterDetail({ admin: { id: 'i1' }, params: { id: RID } }, res);
    expect(res.code).toBe(404);
  });
});

describe('Compare versions, scoped', () => {
  const ID = '507f1f77bcf86cd799439011';
  const findOne = (doc) => ({ select: () => ({ lean: async () => doc }) });
  beforeEach(() => {
    Admin.findById.mockReturnValue(lean({ _id: 'i1', role: 'subeditor', displayRole: 'Bureau', isActive: true, permissions: {} }));
  });

  test('before and after, what changed, the remarks and the trail', async () => {
    News.findOne = jest.fn().mockReturnValue(findOne({
      _id: ID, title: 'Rain in Karimnagar today', content: 'new text', category: 'News', location: 'Karimnagar',
      revisionStatus: {
        remarks: 'Add the date', sentBackBy: 'Raju', revisionCount: 1, resubmittedAt: new Date(),
        revisionSnapshot: { title: 'Rain', content: 'old text', category: 'News', location: 'Karimnagar' },
      },
      actionHistory: [
        { action: 'created', performedByName: 'Ravi', performedAt: new Date() },
        { action: 'needs_revision', performedByName: 'Raju', details: 'Add the date', performedAt: new Date() },
        { action: 'approved', performedByName: 'X' },
      ],
    }));
    const res = mockRes();
    await ctrl.newsVersions({ admin: { id: 'i1' }, params: { id: ID } }, res);
    expect(res.code).toBe(200);
    expect(res.body.previous.title).toBe('Rain');
    expect(res.body.current.title).toBe('Rain in Karimnagar today');
    expect(res.body.changedFields).toEqual(expect.arrayContaining(['title', 'content']));
    expect(res.body.changedFields).not.toContain('category');
    expect(res.body.remarks).toBe('Add the date');
    expect(res.body.history.map((h) => h.action)).toEqual(['created', 'needs_revision']);
    // Scoped like everything else here.
    expect(News.findOne.mock.calls[0][0].scopedFor).toBe('this-incharge');
  });

  test('not in my queue → 404; bad id → 400', async () => {
    News.findOne = jest.fn().mockReturnValue(findOne(null));
    const res = mockRes();
    await ctrl.newsVersions({ admin: { id: 'i1' }, params: { id: ID } }, res);
    expect(res.code).toBe(404);
    const bad = mockRes();
    await ctrl.newsVersions({ admin: { id: 'i1' }, params: { id: 'x' } }, bad);
    expect(bad.code).toBe(400);
  });
});
