'use strict';

/**
 * State In-Charge Agreement — unit/integration tests (no live DB/Redis).
 *
 * Covers: registered-email OTP backbone, anti-enumeration, scoped session
 * isolation, T&C versioning immutability + hash stability, super-admin-only
 * gating (server-side), and the immutable acceptance hash chain.
 */

// ---- Global mocks (models, redis, secrets, side-effect services) -------------
jest.mock('../config/redis', () => {
  let available = true;
  const store = new Map();
  const client = {
    async incr(k) { const n = (Number(store.get(k)) || 0) + 1; store.set(k, n); return n; },
    async expire() { return 1; },
    async exists(k) { return store.has(k) ? 1 : 0; },
    async ttl() { return 60; },
    async set(k, v) { store.set(k, v); return 'OK'; },
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async del(k) { store.delete(k); return 1; }
  };
  return {
    redisClient: client,
    isRedisAvailable: () => available,
    __store: store,
    __setAvailable: (v) => { available = v; },
    __reset: () => { store.clear(); available = true; }
  };
});
jest.mock('../config/secrets', () => ({ getJwtSecret: () => 'test_secret_key_abcdefghijklmnop' }));
jest.mock('../models/Admin', () => ({ findOne: jest.fn(), findById: jest.fn(), updateOne: jest.fn(() => Promise.resolve({})) }));
jest.mock('../models/TncDocument', () => ({ findOne: jest.fn(), find: jest.fn(), findById: jest.fn(), create: jest.fn(), computeHash: jest.fn() }));
jest.mock('../models/AgreementAcceptance', () => ({ findOne: jest.fn(), create: jest.fn(), computeHash: jest.fn() }));
jest.mock('../models/AuditLog', () => ({ create: jest.fn(() => Promise.resolve({})) }));
jest.mock('../services/security/alertEngine', () => ({ record: jest.fn() }));
jest.mock('../middleware/upload', () => ({ uploadToR2: jest.fn(() => Promise.resolve('r2/key.png')) }));
jest.mock('../services/agreement/otpService', () => ({ requestOtp: jest.fn(), verifyOtp: jest.fn() }));
jest.mock('../services/agreement/emailService', () => ({ isConfigured: jest.fn(() => true), sendOtpEmail: jest.fn(() => Promise.resolve()) }));

const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');
const TncDocument = require('../models/TncDocument');
const AgreementAcceptance = require('../models/AgreementAcceptance');
const otpService = require('../services/agreement/otpService');
const emailService = require('../services/agreement/emailService');
const session = require('../services/agreement/session');
const redisMock = require('../config/redis');
const agreementController = require('../controllers/agreementController');
const termsController = require('../controllers/agreementTermsController');

// Real (un-mocked) implementations for pure-logic coverage:
const realOtp = jest.requireActual('../services/agreement/otpService');
const RealTnc = jest.requireActual('../models/TncDocument');
const RealAcc = jest.requireActual('../models/AgreementAcceptance');

// ---- helpers -----------------------------------------------------------------
function mockRes() {
  const res = { statusCode: 200, body: undefined, cookies: {}, cleared: [] };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  res.send = jest.fn((b) => { res.body = b; return res; });
  res.cookie = jest.fn((n, v) => { res.cookies[n] = v; return res; });
  res.clearCookie = jest.fn((n) => { res.cleared.push(n); return res; });
  res.render = jest.fn((view, data) => { res.body = { view, data }; return res; });
  return res;
}
const selectResolves = (doc) => ({ select: () => Promise.resolve(doc) });
const IC = { _id: 'admin1', name: 'Ravi Kumar', email: 'ravi@example.com', role: 'subeditor', isActive: true, displayRole: 'State In-Charge', assignedState: 'Uttar Pradesh', agreementStatus: null };

beforeEach(() => {
  jest.clearAllMocks();
  redisMock.__reset();
});

// =============================================================================
describe('otpService (real, mocked Redis)', () => {
  test('requestOtp issues a 6-digit code; verify accepts it once, rejects replay', async () => {
    const r = await realOtp.requestOtp({ adminId: 'a1', ip: '1.1.1.1' });
    expect(r.status).toBe('sent');
    expect(r.otp).toMatch(/^\d{6}$/);

    const bad = await realOtp.verifyOtp({ adminId: 'a1', otp: r.otp === '000000' ? '111111' : '000000', ip: '1.1.1.1' });
    expect(bad.ok).toBe(false);

    const ok = await realOtp.verifyOtp({ adminId: 'a1', otp: r.otp, ip: '1.1.1.1' });
    expect(ok.ok).toBe(true);

    const replay = await realOtp.verifyOtp({ adminId: 'a1', otp: r.otp, ip: '1.1.1.1' }); // consumed
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('expired');
  });

  test('resend cooldown blocks an immediate second request', async () => {
    await realOtp.requestOtp({ adminId: 'a2', ip: '1.1.1.1' });
    const again = await realOtp.requestOtp({ adminId: 'a2', ip: '1.1.1.1' });
    expect(again.status).toBe('cooldown');
  });

  test('fails safe when Redis is unavailable', async () => {
    redisMock.__setAvailable(false);
    expect((await realOtp.requestOtp({ adminId: 'a3', ip: '1.1.1.1' })).status).toBe('unavailable');
    expect((await realOtp.verifyOtp({ adminId: 'a3', otp: '123456', ip: '1.1.1.1' })).ok).toBe(false);
  });
});

// =============================================================================
describe('scoped agreement session', () => {
  test('issue → read round-trips; purpose is agreement, no role', () => {
    const res = mockRes();
    session.issue(res, { adminId: 'admin1', otpVerified: true });
    const raw = res.cookies[session.COOKIE];
    expect(raw).toBeTruthy();
    const decoded = jwt.verify(raw, 'test_secret_key_abcdefghijklmnop');
    expect(decoded.purpose).toBe('agreement');
    expect(decoded.role).toBeUndefined();
    const s = session.read({ cookies: { [session.COOKIE]: raw } });
    expect(s).toEqual({ adminId: 'admin1', otpVerified: true });
  });

  test('a normal admin JWT is NOT accepted as an agreement session', () => {
    const adminToken = jwt.sign({ id: 'x', role: 'admin' }, 'test_secret_key_abcdefghijklmnop');
    expect(session.read({ cookies: { [session.COOKIE]: adminToken } })).toBeNull();
  });

  test('requireAgreementSession rejects a missing session with 401', () => {
    const res = mockRes(); const next = jest.fn();
    session.requireAgreementSession({ cookies: {} }, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// =============================================================================
describe('agreementController — request/verify OTP', () => {
  test('request-otp returns the SAME generic response for known and unknown emails', async () => {
    otpService.requestOtp.mockResolvedValue({ status: 'sent', otp: '123456' });

    Admin.findOne.mockReturnValue(selectResolves(IC)); // known
    const res1 = mockRes();
    await agreementController.requestOtp({ body: { email: 'ravi@example.com' }, headers: {}, ip: '9.9.9.9' }, res1);

    Admin.findOne.mockReturnValue(selectResolves(null)); // unknown
    const res2 = mockRes();
    await agreementController.requestOtp({ body: { email: 'nobody@example.com' }, headers: {}, ip: '9.9.9.9' }, res2);

    expect(res1.body).toEqual(res2.body);
    expect(res1.body.message).toMatch(/registered State In-Charge/i);
    expect(JSON.stringify(res1.body)).not.toContain('123456'); // OTP never leaks to client
  });

  test('when Redis is down → 503 (email-independent, no enumeration leak, not silently "sent")', async () => {
    redisMock.__setAvailable(false);
    const res = mockRes();
    await agreementController.requestOtp({ body: { email: 'ravi@example.com' }, headers: {}, ip: '9.9.9.9' }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/temporarily unavailable/i);
    expect(Admin.findOne).not.toHaveBeenCalled(); // returns before the email lookup → no leak
    expect(otpService.requestOtp).not.toHaveBeenCalled();
  });

  test('lookup is scoped to role subeditor + active (non-subeditor cannot receive OTP)', async () => {
    otpService.requestOtp.mockResolvedValue({ status: 'sent', otp: '123456' });
    Admin.findOne.mockReturnValue(selectResolves(null));
    await agreementController.requestOtp({ body: { email: 'editor@example.com' }, headers: {}, ip: '9.9.9.9' }, mockRes());
    expect(Admin.findOne).toHaveBeenCalledWith(expect.objectContaining({ role: 'subeditor' }));
  });

  test('verify-otp success issues a session and returns masked identity', async () => {
    Admin.findOne.mockReturnValue(selectResolves(IC));
    otpService.verifyOtp.mockResolvedValue({ ok: true, adminId: 'admin1' });
    const res = mockRes();
    await agreementController.verifyOtp({ body: { email: 'ravi@example.com', otp: '123456' }, headers: {}, ip: '9.9.9.9' }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.identity.emailMasked).toBe('r***@example.com');
    expect(res.body.identity.emailMasked).not.toBe('ravi@example.com');
    expect(res.cookies[session.COOKIE]).toBeTruthy();
  });

  test('verify-otp with a wrong code returns a generic 400', async () => {
    Admin.findOne.mockReturnValue(selectResolves(IC));
    otpService.verifyOtp.mockResolvedValue({ ok: false, reason: 'wrong' });
    const res = mockRes();
    await agreementController.verifyOtp({ body: { email: 'ravi@example.com', otp: '000000' }, headers: {}, ip: '9.9.9.9' }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBeUndefined();
  });
});

// =============================================================================
describe('agreementController — accept', () => {
  const publishedTnc = { version: '1.0', contentHash: 'HASH_V1', title: 't', effectiveFrom: new Date() };
  function baseReq(body) {
    return { agreement: { adminId: 'admin1', otpVerified: true }, body, headers: { 'user-agent': 'jest' }, ip: '9.9.9.9' };
  }
  beforeEach(() => {
    Admin.findById.mockReturnValue(selectResolves(IC));
    TncDocument.findOne.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve(publishedTnc) }) });
    AgreementAcceptance.findOne.mockReturnValue({ sort: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) });
    AgreementAcceptance.computeHash.mockReturnValue('ACC_HASH_1');
    AgreementAcceptance.create.mockResolvedValue({ _id: 'acc1' });
  });

  test('rejects acceptance if the client version differs from the current published version', async () => {
    const res = mockRes();
    await agreementController.accept(baseReq({ acceptedVersion: '0.9', agree: true, typedName: 'Ravi Kumar' }), res);
    expect(res.statusCode).toBe(409);
    expect(AgreementAcceptance.create).not.toHaveBeenCalled();
  });

  test('requires a typed name', async () => {
    const res = mockRes();
    await agreementController.accept(baseReq({ acceptedVersion: '1.0', agree: true, typedName: '   ' }), res);
    expect(res.statusCode).toBe(400);
  });

  test('records an immutable acceptance freezing the accepted version + hash', async () => {
    const res = mockRes();
    await agreementController.accept(baseReq({ acceptedVersion: '1.0', agree: true, typedName: 'Ravi Kumar' }), res);
    expect(res.body.ok).toBe(true);
    const saved = AgreementAcceptance.create.mock.calls[0][0];
    expect(saved.tncVersion).toBe('1.0');
    expect(saved.tncHash).toBe('HASH_V1'); // frozen copy, not a live reference
    expect(saved.otpVerified).toBe(true);
    expect(Admin.updateOne).toHaveBeenCalledWith({ _id: 'admin1' }, { $set: { agreementStatus: 'agreement_accepted' } });
  });
});

// =============================================================================
describe('agreementTermsController — Super-Admin-only gating (server-side)', () => {
  const superReq = (extra = {}) => ({ admin: { role: 'superadmin', id: 's1', username: 'boss' }, params: {}, body: {}, ...extra });
  const adminReq = (extra = {}) => ({ admin: { role: 'admin', id: 'a1' }, params: {}, body: {}, ...extra });

  test('a plain admin CANNOT create a draft (403)', async () => {
    const res = mockRes();
    await termsController.createDraft(adminReq({ body: { version: '1.1' } }), res);
    expect(res.statusCode).toBe(403);
    expect(TncDocument.create).not.toHaveBeenCalled();
  });

  test('a plain admin CANNOT publish (403)', async () => {
    const res = mockRes();
    await termsController.publishDraft(adminReq({ params: { id: 'x' } }), res);
    expect(res.statusCode).toBe(403);
  });

  test('a plain admin CANNOT open the T&C management page (403)', async () => {
    const res = mockRes();
    await termsController.renderTermsAdmin(adminReq(), res);
    expect(res.statusCode).toBe(403);
  });

  test('super admin creates a draft', async () => {
    TncDocument.create.mockResolvedValue({ _id: 'v1' });
    const res = mockRes();
    await termsController.createDraft(superReq({ body: { version: '1.1', bodyEnglish: 'x' } }), res);
    expect(TncDocument.create).toHaveBeenCalledWith(expect.objectContaining({ version: '1.1', status: 'draft' }));
    expect(res.body.ok).toBe(true);
  });

  test('publishing a new version archives the previously published one and freezes a hash', async () => {
    const prevPublished = { status: 'published', save: jest.fn(() => Promise.resolve()) };
    const draft = { status: 'draft', version: '1.1', bodyEnglish: 'new terms', bodyTelugu: '', effectiveFrom: null, save: jest.fn(() => Promise.resolve()) };
    TncDocument.findById.mockResolvedValue(draft);
    TncDocument.find.mockResolvedValue([prevPublished]);
    TncDocument.computeHash.mockReturnValue('FROZEN_HASH_V11');
    const res = mockRes();
    await termsController.publishDraft(superReq({ params: { id: 'v11' } }), res);
    expect(prevPublished.status).toBe('archived');   // old version archived, NOT deleted
    expect(prevPublished.save).toHaveBeenCalled();
    expect(draft.status).toBe('published');
    expect(draft.contentHash).toBe('FROZEN_HASH_V11');
    expect(res.body.ok).toBe(true);
  });

  test('a published version cannot be edited via updateDraft (409)', async () => {
    TncDocument.findById.mockResolvedValue({ status: 'published' });
    const res = mockRes();
    await termsController.updateDraft(superReq({ params: { id: 'v1' }, body: { bodyEnglish: 'tamper' } }), res);
    expect(res.statusCode).toBe(409);
  });

  test('agreement-status page is admin-gated (editor blocked)', async () => {
    const res = mockRes();
    await termsController.renderAgreementStatus({ admin: { role: 'editor' } }, res);
    expect(res.statusCode).toBe(403);
  });
});

// =============================================================================
describe('T&C + acceptance hashing (real models) — immutability & chain', () => {
  test('TncDocument.computeHash is deterministic and content-sensitive', () => {
    const h1 = RealTnc.computeHash('1.0', 'English body', 'Telugu body');
    const h2 = RealTnc.computeHash('1.0', 'English body', 'Telugu body');
    const h3 = RealTnc.computeHash('1.0', 'English body EDITED', 'Telugu body');
    const h4 = RealTnc.computeHash('1.1', 'English body', 'Telugu body');
    expect(h1).toBe(h2);          // stable → old published hash never drifts
    expect(h1).not.toBe(h3);      // any content change ⇒ new hash
    expect(h1).not.toBe(h4);      // version is part of the hash
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  test('an old acceptance keeps its own frozen (version, hash) after a newer T&C exists', () => {
    const oldHash = RealTnc.computeHash('1.0', 'v1 EN', 'v1 TE');
    const newHash = RealTnc.computeHash('2.0', 'v2 EN', 'v2 TE');
    expect(oldHash).not.toBe(newHash);
    // The old acceptance stored version 1.0 + oldHash; recomputing v1 still yields oldHash.
    expect(RealTnc.computeHash('1.0', 'v1 EN', 'v1 TE')).toBe(oldHash);
  });

  test('AgreementAcceptance.computeHash chains on previousHash (tamper-evident)', () => {
    const f = { adminId: 'a1', tncVersion: '1.0', tncHash: 'H1', acceptedAt: new Date('2026-01-01T00:00:00Z'), ip: '1.1.1.1', typedName: 'Ravi', otpVerified: true };
    const first = RealAcc.computeHash(f, '');
    const second = RealAcc.computeHash(f, first);
    expect(first).toBe(RealAcc.computeHash(f, ''));  // deterministic
    expect(second).not.toBe(first);                  // previousHash changes the result
    const tampered = RealAcc.computeHash({ ...f, tncHash: 'H2' }, '');
    expect(tampered).not.toBe(first);                // altering the referenced T&C hash is detectable
  });
});
