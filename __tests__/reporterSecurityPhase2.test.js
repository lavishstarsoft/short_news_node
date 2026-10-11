'use strict';

/**
 * Reporter Security Phase 2 — one-device login, device + GPS on news, and the
 * reporter-only app-version gate.
 *
 * Rules are OFF by default and tokens issued before sessions existed keep working
 * until "strict" is switched on, so turning the rule on never logs out the reporters
 * already using the live app.
 */
const mongoose = require('mongoose');

const flags = {
  payoutLinkHold: false, sicSelfApprovalBlock: false, sicSelfApprovalWindowDays: 30,
  blockUnapprovedAppLogin: false, closeReporterPortal: false, reporterLoginRateLimit: false,
  singleDeviceLogin: false, singleDeviceStrict: false, requireGpsOnNews: false, minReporterAppVersion: '',
};
jest.mock('../services/security/reporterSecuritySettings', () => ({ get: jest.fn(async () => ({ ...flags })), current: jest.fn(() => ({ ...flags })) }));
jest.mock('../services/security/reporterLoginRecorder', () => ({ recordAppLogin: jest.fn() }));
jest.mock('../services/security/accountLinks', () => ({
  ...jest.requireActual('../services/security/accountLinks'),
  findLinksFor: jest.fn(async () => ({ linkedAdminIds: [], reasons: [] })),
  sicProposal: jest.fn(async () => null),
}));
jest.mock('../services/security/alertEngine', () => ({ record: jest.fn(), isBlocked: jest.fn(async () => false) }));

const mockAdminModel = { findByUsernameOrEmail: jest.fn(), findById: jest.fn(), updateOne: jest.fn(async () => ({})), findOne: jest.fn() };
jest.mock('../models/Admin', () => {
  const Ctor = jest.fn(function (p) { Object.assign(this, p); this._id = new (require('mongoose').Types.ObjectId)(); this.save = async () => this; });
  Ctor.findByUsernameOrEmail = (...a) => mockAdminModel.findByUsernameOrEmail(...a);
  Ctor.findById = (...a) => mockAdminModel.findById(...a);
  Ctor.updateOne = (...a) => mockAdminModel.updateOne(...a);
  Ctor.findOne = (...a) => mockAdminModel.findOne(...a);
  Ctor.find = () => ({ select: () => ({ lean: async () => [] }) });
  Ctor.distinct = async () => [];
  return Ctor;
});
const mockDeviceLink = { updateOne: jest.fn(async () => ({})), find: jest.fn() };
jest.mock('../models/ReporterDeviceLink', () => mockDeviceLink);
jest.mock('../models/WithdrawalRequest', () => ({ findOne: jest.fn(), create: jest.fn(), findById: jest.fn(), find: jest.fn(), distinct: jest.fn() }));
jest.mock('../models/AppSettings', () => ({ findOne: jest.fn(async () => ({ minWithdrawalAmount: 500 })) }));
jest.mock('../models/AuditLog', () => ({ create: async (d) => d }));
jest.mock('node-fetch', () => jest.fn());
jest.mock('../config/redis', () => ({ redisClient: {}, isRedisAvailable: () => false }));
jest.mock('../services/oneSignalService', () => ({}));
jest.mock('../middleware/cache', () => ({ clearCache: jest.fn() }));

const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config/secrets');
const adminController = require('../controllers/adminController');
const session = require('../services/security/reporterSession');
const { deviceContext } = require('../services/security/deviceContext');

function res() {
  return {
    code: 200, body: null, redirected: null, cleared: false,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
    redirect(u) { this.redirected = u; return this; },
    clearCookie() { this.cleared = true; return this; },
    locals: {},
  };
}
const setFlags = (o) => Object.assign(flags, {
  singleDeviceLogin: false, singleDeviceStrict: false, requireGpsOnNews: false, minReporterAppVersion: '',
  blockUnapprovedAppLogin: false, closeReporterPortal: false, payoutLinkHold: false, sicSelfApprovalBlock: false,
}, o);

const APP_REQ = (over = {}) => ({
  headers: { 'x-device-id': 'phone-aaaa1111', 'user-agent': 'Dart/3.5', 'x-forwarded-for': '49.205.144.10', ...(over.headers || {}) },
  connection: { remoteAddress: '49.205.144.10' },
  body: { username: 'ravi', password: 'right', deviceModel: 'Redmi Note 12', platform: 'android', appVersion: '2.0.30', ...(over.body || {}) },
  app: { locals: { io: over.io || null, isConnectedToMongoDB: true } },
  ...(over.extra || {}),
});

beforeEach(() => { jest.clearAllMocks(); setFlags({}); });

describe('one-device login', () => {
  const account = (over) => ({ _id: new mongoose.Types.ObjectId(), username: 'ravi', role: 'editor', isActive: true, isApproved: true, comparePassword: async (p) => p === 'right', ...over });

  test('rule OFF → no session is written and the token has no sid (nothing changes)', async () => {
    mockAdminModel.findByUsernameOrEmail.mockResolvedValue(account());
    const r = res();
    await adminController.reporterLogin(APP_REQ(), r);
    expect(r.code).toBe(200);
    expect(jwt.decode(r.body.token).sid).toBeUndefined();
    expect(mockAdminModel.updateOne).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ $set: expect.objectContaining({ activeSession: expect.anything() }) }));
  });

  test('rule ON → session saved with the phone, sid in the token, phone remembered', async () => {
    setFlags({ singleDeviceLogin: true });
    const a = account();
    mockAdminModel.findByUsernameOrEmail.mockResolvedValue(a);
    const r = res();
    await adminController.reporterLogin(APP_REQ(), r);
    const sid = jwt.decode(r.body.token).sid;
    expect(sid).toEqual(expect.any(String));
    const sessionWrite = mockAdminModel.updateOne.mock.calls.find((c) => c[1].$set && c[1].$set.activeSession);
    expect(sessionWrite[1].$set.activeSession).toMatchObject({
      sid, deviceId: 'phone-aaaa1111', deviceModel: 'Redmi Note 12', platform: 'android', appVersion: '2.0.30', ip: '49.205.144.10',
    });
    expect(mockDeviceLink.updateOne).toHaveBeenCalledWith(
      { deviceId: 'phone-aaaa1111', adminId: a._id },
      expect.objectContaining({ $inc: { logins: 1 } }),
      { upsert: true },
    );
  });

  test('a second phone kicks the first: socket event + disconnect, only for the replaced session', async () => {
    setFlags({ singleDeviceLogin: true });
    const emitted = [];
    const oldSocket = { data: { sid: 'OLD-SID' }, disconnect: jest.fn() };
    const newSocket = { data: { sid: 'SOME-OTHER' }, disconnect: jest.fn() };
    const io = {
      to: () => ({ emit: (ev, payload) => emitted.push([ev, payload]) }),
      in: () => ({ fetchSockets: async () => [oldSocket, newSocket] }),
    };
    mockAdminModel.findByUsernameOrEmail.mockResolvedValue(account({ activeSession: { sid: 'OLD-SID' } }));
    await adminController.reporterLogin(APP_REQ({ io }), res());
    await new Promise((r) => setImmediate(r));
    expect(emitted[0][0]).toBe('session_revoked');
    expect(emitted[0][1]).toMatchObject({ sid: 'OLD-SID', reason: 'new_login', deviceModel: 'Redmi Note 12' });
    expect(oldSocket.disconnect).toHaveBeenCalledWith(true);
    expect(newSocket.disconnect).not.toHaveBeenCalled();
  });

  test('a failed session write never blocks the login', async () => {
    setFlags({ singleDeviceLogin: true });
    mockAdminModel.findByUsernameOrEmail.mockResolvedValue(account());
    mockAdminModel.updateOne.mockRejectedValueOnce(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = res();
    await adminController.reporterLogin(APP_REQ(), r);
    spy.mockRestore();
    expect(r.code).toBe(200);
    expect(r.body.token).toEqual(expect.any(String));
  });

  describe('requireAuth enforcement', () => {
    // requireAuth answers through res.json / res.redirect / next() — whichever comes first.
    const call = (tokenPayload, latest) => {
      mockAdminModel.findById.mockReturnValue({ select: () => Promise.resolve(latest) });
      const token = jwt.sign(tokenPayload, getJwtSecret(), { expiresIn: '7d' });
      return new Promise((done) => {
        const out = { code: 200, body: null, redirected: null, passed: false, locals: {} };
        const fake = {
          locals: {},
          status(c) { out.code = c; return this; },
          json(b) { out.body = b; done(out); return this; },
          redirect(u) { out.redirected = u; done(out); return this; },
          clearCookie() { return this; },
        };
        adminController.requireAuth(
          { cookies: {}, headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, path: '/api/x', originalUrl: '/admin/api/reporter/profile', app: { locals: { isConnectedToMongoDB: true } } },
          fake,
          () => { out.passed = true; done(out); },
        );
      });
    };
    const id = new mongoose.Types.ObjectId();
    const reporter = (sid) => ({ _id: id, role: 'editor', isActive: true, permissions: {}, activeSession: { sid } });

    test('matching session passes; replaced session → 401 SESSION_REPLACED', async () => {
      setFlags({ singleDeviceLogin: true });
      expect((await call({ id: String(id), role: 'editor', sid: 'S1' }, reporter('S1'))).passed).toBe(true);
      const kicked = await call({ id: String(id), role: 'editor', sid: 'S1' }, reporter('S2'));
      expect(kicked.code).toBe(401);
      expect(kicked.body).toMatchObject({ code: 'SESSION_REPLACED' });
      expect(kicked.body.error).toMatch(/another phone/);
    });

    test('old tokens without a sid keep working until strict is on', async () => {
      setFlags({ singleDeviceLogin: true });
      expect((await call({ id: String(id), role: 'editor' }, reporter('S2'))).passed).toBe(true);
      setFlags({ singleDeviceLogin: true, singleDeviceStrict: true });
      const strict = await call({ id: String(id), role: 'editor' }, reporter('S2'));
      expect(strict.code).toBe(401);
      expect(strict.body.code).toBe('SESSION_REPLACED');
    });

    test('rule OFF → a stale sid still works; admins are never kicked', async () => {
      expect((await call({ id: String(id), role: 'editor', sid: 'OLD' }, reporter('NEW'))).passed).toBe(true);
      setFlags({ singleDeviceLogin: true });
      const admin = { _id: id, role: 'admin', isActive: true, permissions: { canAccessAdminDashboard: true }, activeSession: { sid: 'NEW' } };
      expect((await call({ id: String(id), role: 'admin', sid: 'OLD' }, admin)).passed).toBe(true);
    });
  });
});

describe('app version gate (reporters only)', () => {
  test('older than the minimum → 426 with a clear message; equal or newer is fine', async () => {
    setFlags({ minReporterAppVersion: '2.0.30' });
    mockAdminModel.findByUsernameOrEmail.mockResolvedValue({ _id: new mongoose.Types.ObjectId(), username: 'ravi', role: 'editor', isActive: true, comparePassword: async () => true });
    const old = res();
    await adminController.reporterLogin(APP_REQ({ body: { appVersion: '2.0.28' } }), old);
    expect(old.code).toBe(426);
    expect(old.body).toMatchObject({ code: 'APP_UPDATE_REQUIRED', minVersion: '2.0.30' });
    const ok = res();
    await adminController.reporterLogin(APP_REQ({ body: { appVersion: '2.1.0' } }), ok);
    expect(ok.code).toBe(200);
  });

  test('an app that sends no version is still allowed (it must be able to update)', async () => {
    setFlags({ minReporterAppVersion: '2.0.30' });
    mockAdminModel.findByUsernameOrEmail.mockResolvedValue({ _id: new mongoose.Types.ObjectId(), username: 'ravi', role: 'editor', isActive: true, comparePassword: async () => true });
    const r = res();
    await adminController.reporterLogin(APP_REQ({ body: { appVersion: '' } }), r);
    expect(r.code).toBe(200);
  });
});

describe('device + GPS on news (deviceContext)', () => {
  test('device id only from the header/named field, GPS validated', () => {
    const ctx = deviceContext({
      headers: { 'x-device-id': 'phone-aaaa1111', 'x-app-source': 'reporter-app', 'x-forwarded-for': '49.205.144.10' },
      body: { deviceModel: 'Redmi Note 12', platform: 'Android', appVersion: '2.0.30', gps: { lat: 17.2473, lng: 80.1514, accuracy: 12, isMocked: true } },
      connection: { remoteAddress: '49.205.144.10' },
    });
    expect(ctx).toMatchObject({ deviceId: 'phone-aaaa1111', deviceModel: 'Redmi Note 12', platform: 'android', appSource: 'reporter-app', ipCountry: 'IN' });
    expect(ctx.gps).toMatchObject({ lat: 17.2473, lng: 80.1514, accuracy: 12, mock: true });
  });

  test('bogus device ids and impossible coordinates are dropped', () => {
    const ctx = deviceContext({ headers: { 'x-device-id': 'ab' }, body: { gps: { lat: 999, lng: 80 } } });
    expect(ctx.deviceId).toBe('');
    expect(ctx.gps).toBeNull();
    expect(deviceContext({ headers: {}, body: { lat: 0, lng: 0 } }).gps).toBeNull();
  });
});

describe('posted-from is Super Admin only', () => {
  const ejs = require('ejs');
  const fs = require('fs');
  const path = require('path');
  const cardPath = path.join(__dirname, '..', 'views', 'partials', 'pending-news-card.ejs');
  const card = fs.readFileSync(cardPath, 'utf8');
  const news = {
    _id: 'n1', title: 'T', content: 'C', author: 'ravi', publishedAt: new Date(), category: 'News',
    location: 'Khammam', actionHistory: [],
    authorDetails: { name: 'Ravi', mobileNumber: '9876543210', email: 'r@x.com', constituency: 'Khammam' },
    postedFrom: { deviceModel: 'Redmi Note 12', deviceId: 'a-abcd1234efgh', appVersion: '2.0.30', lat: 17.2473, lng: 80.1514, ipCity: 'Lucknow', ipRegion: 'UP' },
  };
  // Helpers the page normally supplies through app.locals.
  const { renderRichText, renderRichTextExcerpt, stripRichTags } = require('../utils/richTextRenderer');
  const render = (locals) => ejs.render(card, {
    news, showFullDetails: false, showReporterContact: false, isSuperAdmin: false,
    renderRichText, renderRichTextExcerpt, stripRichTags,
    pendingLangLabels: { hi: 'HINDI', te: 'TELUGU' },
    isAIQueue: false, canApproveNews: true, canDeleteAiQueue: false,
    ...locals,
  }, { filename: cardPath });

  test('Super Admin sees the phone, GPS and internet city', () => {
    const html = render({ isSuperAdmin: true, showFullDetails: true });
    expect(html).toContain('Posted from');
    expect(html).toContain('Redmi Note 12');
    expect(html).toContain('abcd1234efgh'.slice(-8));
    expect(html).toContain('17.24730');
    expect(html).toContain('Lucknow, UP');
  });

  test('admin with reporter-details permission does NOT see it', () => {
    const html = render({ isSuperAdmin: false, showFullDetails: true });
    expect(html).not.toContain('Posted from');
    expect(html).not.toContain('Redmi Note 12');
    expect(html).not.toContain('Lucknow');
    expect(html).toContain('Ravi'); // the rest of the card is unchanged
  });

  test('State In-Charge (reporter contact view) does NOT see it', () => {
    const html = render({ isSuperAdmin: false, showReporterContact: true });
    expect(html).not.toContain('Posted from');
    expect(html).not.toContain('a-abcd1234efgh');
    expect(html).toContain('9876543210'); // they still get the reporter's mobile
  });

  test('desk / anyone else does NOT see it', () => {
    const html = render({});
    expect(html).not.toContain('Posted from');
    expect(html).not.toContain('80.15');
  });
});

describe('two far-apart places (Khammam / Nalgonda)', () => {
  const { haversineKm, isSequential } = jest.requireActual('../services/security/accountLinks');
  test('distance between real towns', () => {
    expect(Math.round(haversineKm({ lat: 17.2473, lng: 80.1514 }, { lat: 17.0575, lng: 79.2684 }))).toBe(96);
    expect(Math.round(haversineKm({ lat: 17.2473, lng: 80.1514 }, { lat: 17.2480, lng: 80.1520 }))).toBe(0);
  });
  test('accounts taking turns on one phone are flagged as sequential', () => {
    const d = (s) => new Date(s).toISOString();
    expect(isSequential([{ firstSeenAt: d('2026-01-01'), lastSeenAt: d('2026-01-10') }, { firstSeenAt: d('2026-01-12'), lastSeenAt: d('2026-01-20') }])).toBe(true);
    expect(isSequential([{ firstSeenAt: d('2026-01-01'), lastSeenAt: d('2026-01-20') }, { firstSeenAt: d('2026-01-05'), lastSeenAt: d('2026-01-25') }])).toBe(false);
  });
});
