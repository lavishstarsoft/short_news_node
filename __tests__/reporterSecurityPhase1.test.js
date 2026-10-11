'use strict';

/**
 * Reporter Security Phase 1 — the rules as wired into the live handlers:
 *  - app login is recorded; unapproved self sign-ups blocked only when switched ON
 *  - same UPI / bank / mobile → withdrawal held (reporter sees a normal request) and
 *    cannot be paid until the Super Admin clears it
 *  - a State In-Charge can't approve news of a reporter they proposed (when ON)
 *  - the reporter web portal login / sign-up closed (when ON)
 * Every rule OFF → behaviour exactly as before.
 */
const mongoose = require('mongoose');

const flags = { payoutLinkHold: false, sicSelfApprovalBlock: false, sicSelfApprovalWindowDays: 30, blockUnapprovedAppLogin: false, closeReporterPortal: false, reporterLoginRateLimit: false };
jest.mock('../services/security/reporterSecuritySettings', () => ({ get: jest.fn(async () => ({ ...flags })), current: jest.fn(() => ({ ...flags })) }));
jest.mock('../services/security/reporterLoginRecorder', () => ({ recordAppLogin: jest.fn() }));
jest.mock('../services/security/accountLinks', () => ({
  ...jest.requireActual('../services/security/accountLinks'),
  findLinksFor: jest.fn(async () => ({ linkedAdminIds: [], reasons: [] })),
  sicProposal: jest.fn(async () => null),
}));
jest.mock('../services/security/alertEngine', () => ({ record: jest.fn(), isBlocked: jest.fn(async () => false) }));

const mockAdmin = { findByUsernameOrEmail: jest.fn(), findById: jest.fn(), findOne: jest.fn() };
jest.mock('../models/Admin', () => {
  const Ctor = jest.fn(function (p) { Object.assign(this, p); this._id = new (require('mongoose').Types.ObjectId)(); this.save = async () => this; });
  Ctor.findByUsernameOrEmail = (...a) => mockAdmin.findByUsernameOrEmail(...a);
  Ctor.findById = (...a) => mockAdmin.findById(...a);
  Ctor.findOne = (...a) => mockAdmin.findOne(...a);
  Ctor.find = () => ({ select: () => ({ lean: async () => [], sort: () => ({ lean: async () => [] }) }) });
  return Ctor;
});
const mockWithdrawal = { findOne: jest.fn(), create: jest.fn(), findById: jest.fn() };
jest.mock('../models/WithdrawalRequest', () => mockWithdrawal);
jest.mock('../models/AppSettings', () => ({ findOne: jest.fn(async () => ({ minWithdrawalAmount: 500 })) }));
const mockNews = { findById: jest.fn(), findOneAndUpdate: jest.fn() };
jest.mock('../models/News', () => mockNews);
jest.mock('../models/AuditLog', () => ({ create: async (d) => d }));
jest.mock('node-fetch', () => jest.fn());
jest.mock('../config/redis', () => ({ redisClient: {}, isRedisAvailable: () => false }));
jest.mock('../services/oneSignalService', () => ({}));
jest.mock('../middleware/cache', () => ({ clearCache: jest.fn() }));

const adminController = require('../controllers/adminController');
const { recordAppLogin } = require('../services/security/reporterLoginRecorder');
const accountLinks = require('../services/security/accountLinks');
const alertEngine = require('../services/security/alertEngine');

function res() { return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
const setFlags = (o) => Object.assign(flags, { payoutLinkHold: false, sicSelfApprovalBlock: false, blockUnapprovedAppLogin: false, closeReporterPortal: false }, o);
const ip = { headers: {}, connection: { remoteAddress: '1.2.3.4' } };

beforeEach(() => {
  jest.clearAllMocks();
  setFlags({});
  accountLinks.findLinksFor.mockResolvedValue({ linkedAdminIds: [], reasons: [] });
  accountLinks.sicProposal.mockResolvedValue(null);
});

describe('reporter app login', () => {
  const account = (over) => ({ _id: new mongoose.Types.ObjectId(), username: 'ravi', role: 'editor', isActive: true, isApproved: true, comparePassword: async (p) => p === 'right', ...over });

  test('success is recorded and returns the token (unchanged response)', async () => {
    const a = account();
    mockAdmin.findByUsernameOrEmail.mockResolvedValue(a);
    const r = res();
    await adminController.reporterLogin({ ...ip, body: { username: 'ravi', password: 'right' } }, r);
    expect(r.code).toBe(200);
    expect(r.body.token).toEqual(expect.any(String));
    expect(recordAppLogin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ admin: a, success: true, reason: 'ok' }));
  });

  test('wrong password / unknown account are recorded as failures', async () => {
    mockAdmin.findByUsernameOrEmail.mockResolvedValue(account());
    await adminController.reporterLogin({ ...ip, body: { username: 'ravi', password: 'wrong' } }, res());
    expect(recordAppLogin).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ success: false, reason: 'bad_password' }));
    mockAdmin.findByUsernameOrEmail.mockResolvedValue(null);
    await adminController.reporterLogin({ ...ip, body: { username: 'ghost', password: 'x' } }, res());
    expect(recordAppLogin).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ username: 'ghost', success: false, reason: 'no_account' }));
  });

  test('unapproved self sign-up: allowed while the switch is OFF, refused when ON; admin-created accounts unaffected', async () => {
    mockAdmin.findByUsernameOrEmail.mockResolvedValue(account({ isApproved: false }));
    const off = res();
    await adminController.reporterLogin({ ...ip, body: { username: 'ravi', password: 'right' } }, off);
    expect(off.code).toBe(200);

    setFlags({ blockUnapprovedAppLogin: true });
    const on = res();
    await adminController.reporterLogin({ ...ip, body: { username: 'ravi', password: 'right' } }, on);
    expect(on.code).toBe(403);
    expect(on.body.error).toMatch(/not approved/);
    expect(recordAppLogin).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ reason: 'not_approved' }));

    mockAdmin.findByUsernameOrEmail.mockResolvedValue(account({ isApproved: undefined })); // old docs without the field
    const legacy = res();
    await adminController.reporterLogin({ ...ip, body: { username: 'ravi', password: 'right' } }, legacy);
    expect(legacy.code).toBe(200);
  });
});

describe('withdrawal hold (same UPI / bank / mobile on another account)', () => {
  const reporter = () => ({ _id: new mongoose.Types.ObjectId(), username: 'sb', mobileNumber: '9876543210', walletConfig: { enabled: true }, walletBalance: 1000 });
  const call = async (r) => {
    mockAdmin.findById.mockResolvedValue(r);
    mockWithdrawal.findOne.mockResolvedValue(null);
    mockWithdrawal.create.mockImplementation(async (d) => ({ _id: new mongoose.Types.ObjectId(), createdAt: new Date(), ...d }));
    const out = res();
    await adminController.createReporterWithdrawal({ admin: { id: String(r._id) }, body: { amount: 500, type: 'upi', upiId: 'Ravi@ybl' } }, out);
    return out;
  };

  test('switch OFF → no link check, request as before (but the payout key is stored)', async () => {
    const out = await call(reporter());
    expect(out.body.success).toBe(true);
    expect(accountLinks.findLinksFor).not.toHaveBeenCalled();
    const doc = mockWithdrawal.create.mock.calls[0][0];
    expect(doc.payoutKey).toBe('upi:ravi@ybl');
    expect(doc.fraudHold).toBeUndefined();
  });

  test('switch ON + UPI also used by 2 other accounts → held + HIGH alert; reporter response unchanged', async () => {
    setFlags({ payoutLinkHold: true });
    accountLinks.findLinksFor.mockResolvedValue({ linkedAdminIds: ['A', 'C'], reasons: [{ kind: 'upi', label: 'UPI ravi@ybl', adminIds: ['A', 'C'] }] });
    const r = reporter();
    const out = await call(r);
    expect(accountLinks.findLinksFor).toHaveBeenCalledWith(r._id, { payoutKeys: ['upi:ravi@ybl'], mobile: '9876543210' });
    expect(out.body).toMatchObject({ success: true, message: 'Withdrawal request submitted', withdrawal: { status: 'pending' } });
    expect(JSON.stringify(out.body)).not.toMatch(/hold/i);
    const doc = mockWithdrawal.create.mock.calls[0][0];
    expect(doc.fraudHold).toMatchObject({ held: true, linkedAdminIds: ['A', 'C'] });
    expect(alertEngine.record).toHaveBeenCalledWith(expect.objectContaining({ type: 'account_link', persist: true, severity: 'HIGH', account: 'sb' }));
  });

  test('switch ON but nothing shared → normal request', async () => {
    setFlags({ payoutLinkHold: true });
    await call(reporter());
    expect(mockWithdrawal.create.mock.calls[0][0].fraudHold).toBeUndefined();
  });

  test('a link-check failure never blocks a genuine request', async () => {
    setFlags({ payoutLinkHold: true });
    accountLinks.findLinksFor.mockRejectedValue(new Error('db'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const out = await call(reporter());
    spy.mockRestore();
    expect(out.body.success).toBe(true);
  });

  test('a held request cannot be approved (paid) until cleared; reject still works', async () => {
    const w = { _id: 'w1', status: 'pending', amount: 500, adminId: { _id: 'rep', name: 'SB' }, fraudHold: { held: true, clearedAt: null }, save: jest.fn(async () => {}) };
    mockWithdrawal.findById.mockReturnValue({ populate: async () => w });
    const pay = res();
    await adminController.processWalletWithdrawal({ params: { id: 'w1' }, body: { action: 'approve' }, admin: { id: 'boss' } }, pay);
    expect(pay.code).toBe(423);
    expect(pay.body.error).toMatch(/HOLD/);
    const rej = res();
    await adminController.processWalletWithdrawal({ params: { id: 'w1' }, body: { action: 'reject', remarks: 'duplicate accounts' }, admin: { id: 'boss' } }, rej);
    expect(rej.code).toBe(200);
    expect(w.status).toBe('rejected');
  });
});

describe('State In-Charge cannot approve reporters they proposed', () => {
  const sicId = new mongoose.Types.ObjectId();
  const newsId = new mongoose.Types.ObjectId();
  const run = async () => {
    mockAdmin.findById.mockReturnValue({ select: () => ({ lean: async () => ({ _id: sicId, username: 'sic', role: 'subeditor', permissions: { canApproveNews: true } }) }) });
    mockNews.findById.mockReturnValue({ lean: async () => ({ _id: newsId, authorId: 'rep1', isActive: false, rejectionStatus: {} }) });
    mockNews.findOneAndUpdate.mockResolvedValue(null); // stop right after the checks
    const r = res();
    await adminController.approveNews({ params: { id: String(newsId) }, body: { ignoreLanguageWarning: true }, admin: { id: String(sicId) } }, r);
    return r;
  };

  test('switch OFF → the proposal is not even looked up', async () => {
    await run();
    expect(accountLinks.sicProposal).not.toHaveBeenCalled();
  });

  test('switch ON + own proposal → 403 SELF_PROPOSED_REPORTER; no proposal → carries on', async () => {
    setFlags({ sicSelfApprovalBlock: true, sicSelfApprovalWindowDays: 30 });
    accountLinks.sicProposal.mockResolvedValue({ tier: 'stringer' });
    const blocked = await run();
    expect(accountLinks.sicProposal).toHaveBeenCalledWith(String(sicId), 'rep1', 30);
    expect(blocked.code).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'SELF_PROPOSED_REPORTER' });
    expect(blocked.body.error).toMatch(/a stringer/);

    accountLinks.sicProposal.mockResolvedValue(null);
    const allowed = await run();
    expect(allowed.body && allowed.body.code).not.toBe('SELF_PROPOSED_REPORTER');
  });
});

describe('reporter web portal (GraphQL)', () => {
  const resolvers = require('../graphql/resolvers');
  const M = resolvers.Mutation || (resolvers.resolvers && resolvers.resolvers.Mutation);

  test('closed → login and sign-up refused with a pointer to the app', async () => {
    setFlags({ closeReporterPortal: true });
    const login = await M.loginEditor(null, { username: 'ravi', password: 'x' });
    expect(login).toMatchObject({ success: false, token: null });
    expect(login.message).toMatch(/Tehelka News app/);
    const reg = await M.registerEditor(null, { username: 'new', email: 'n@x.com', password: 'secret1' });
    expect(reg).toMatchObject({ success: false, token: null });
    expect(reg.message).toMatch(/closed/);
    expect(mockAdmin.findOne).not.toHaveBeenCalled();
  });

  test('open (default) → sign-up records it as a portal self sign-up', async () => {
    mockAdmin.findOne.mockResolvedValue(null);
    const reg = await M.registerEditor(null, { username: 'new', email: 'n@x.com', password: 'secret1' });
    expect(reg.success).toBe(true);
    const Admin = require('../models/Admin');
    expect(Admin.mock.calls[0][0]).toMatchObject({ isApproved: false, createdVia: 'portal_signup' });
  });
});
