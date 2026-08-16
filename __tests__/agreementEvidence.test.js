'use strict';

/**
 * Agreement Evidence detail + already-completed/duplicate-prevention + IDOR/authz +
 * frozen-T&C integrity + address/GPS separation. Models mocked (no DB).
 */

jest.mock('../models/AgreementAcceptance', () => ({ findOne: jest.fn(), findById: jest.fn(), create: jest.fn(), computeHash: jest.fn(() => 'ACCHASH') }));
jest.mock('../models/TncDocument', () => ({ findOne: jest.fn(), computeHash: jest.fn() }));
jest.mock('../models/ReporterApplication', () => ({ findOne: jest.fn() }));
jest.mock('../models/Admin', () => ({ findOne: jest.fn(), findById: jest.fn(), updateOne: jest.fn(() => Promise.resolve({})) }));
jest.mock('../models/AuditLog', () => ({ create: jest.fn(() => Promise.resolve({})) }));
jest.mock('../services/agreement/otpService', () => ({ requestOtp: jest.fn(), verifyOtp: jest.fn() }));
jest.mock('../services/agreement/emailService', () => ({ isConfigured: jest.fn(() => true), sendOtpEmail: jest.fn(() => Promise.resolve()) }));
jest.mock('../config/redis', () => ({ redisClient: {}, isRedisAvailable: () => true }));
jest.mock('../config/secrets', () => ({ getJwtSecret: () => 'test_secret_key_abcdefghijklmnop' }));

const AgreementAcceptance = require('../models/AgreementAcceptance');
const TncDocument = require('../models/TncDocument');
const ReporterApplication = require('../models/ReporterApplication');
const Admin = require('../models/Admin');
const otpService = require('../services/agreement/otpService');
const { buildEvidence } = require('../services/agreement/evidence');
const agreementController = require('../controllers/agreementController');
const termsController = require('../controllers/agreementTermsController');

function mockRes() {
  const res = { statusCode: 200, body: undefined, cookies: {}, rendered: null };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  res.send = jest.fn((b) => { res.body = b; return res; });
  res.cookie = jest.fn((n, v) => { res.cookies[n] = v; return res; });
  res.clearCookie = jest.fn(() => res);
  res.render = jest.fn((v, d) => { res.rendered = { view: v, data: d }; return res; });
  return res;
}
const VALID_ID = '6a7eb90110fbca123c922d51';
const ACC = {
  _id: VALID_ID, adminId: 'admin1', name: 'Ravi Kumar', email: 'ravi@example.com', designation: 'State In-Charge',
  state: 'Uttar Pradesh', tncVersion: '1.0.0', tncHash: 'H1', acceptedAt: new Date('2026-08-14T00:00:00Z'),
  createdAt: new Date('2026-08-14T00:00:01Z'), otpVerified: true, typedName: 'Ravi Kumar', signatureRef: 'https://r2/sig.png',
  ip: '49.47.249.1', userAgent: 'UA', deviceMetadata: { platform: 'MacIntel' }, locationPermission: 'granted',
  latitude: 16.5165, longitude: 80.6376, acceptanceHash: 'ACC1', previousHash: 'PREV0', workerId: '0:5051'
};
const TNC = { version: '1.0.0', title: 'T&C', publishedAt: new Date('2026-08-13T00:00:00Z'), bodyEnglish: 'FULL ENGLISH TERMS', bodyTelugu: 'FULL ENGLISH TERMS', contentHash: 'H1' };
const chainLean = (v) => ({ lean: () => Promise.resolve(v) });
const chainSortLean = (v) => ({ sort: () => ({ lean: () => Promise.resolve(v) }) });
const chainSelectLean = (v) => ({ select: () => ({ lean: () => Promise.resolve(v) }) });

beforeEach(() => {
  jest.clearAllMocks();
  TncDocument.findOne.mockReturnValue(chainLean(TNC));
  TncDocument.computeHash.mockReturnValue('H1'); // matches frozen hash
  ReporterApplication.findOne.mockReturnValue(chainSelectLean(null)); // no registered address by default
});

describe('buildEvidence — frozen T&C integrity + address/GPS separation', () => {
  test('reproduces exact accepted version, verifies hash, masks email, separates address vs GPS', async () => {
    ReporterApplication.findOne.mockReturnValue(chainSelectLean({ data: { Address: '12 MG Road, Banda' } }));
    const ev = await buildEvidence(ACC);
    expect(ev.agreement.tncVersion).toBe('1.0.0');
    expect(ev.agreement.content).toBe('FULL ENGLISH TERMS');   // exact frozen content
    expect(ev.agreement.integrity).toBe(true);                  // hash matches
    expect(ev.identity.emailMasked).toBe('r***@example.com');   // masked, not raw
    expect(ev.registeredAddress).toBe('12 MG Road, Banda');     // separate field
    expect(ev.location.hasGps).toBe(true);
    expect(ev.location.latitude).toBe(16.5165);
    // GPS is never merged into the address:
    expect(ev.registeredAddress).not.toContain('16.5');
  });

  test('integrity FALSE when the stored content hash no longer matches the frozen hash', async () => {
    TncDocument.computeHash.mockReturnValue('DIFFERENT');
    const ev = await buildEvidence(ACC);
    expect(ev.agreement.integrity).toBe(false);
  });

  test('no registered address → "not merged", GPS still shown; address null', async () => {
    const ev = await buildEvidence({ ...ACC, latitude: null, longitude: null, locationPermission: 'denied' });
    expect(ev.registeredAddress).toBeNull();
    expect(ev.location.hasGps).toBe(false);
  });
});

describe('renderAcceptanceDetail — authorization + IDOR', () => {
  test('non-admin blocked (403)', async () => {
    const res = mockRes();
    await termsController.renderAcceptanceDetail({ admin: { role: 'editor' }, params: { acceptanceId: VALID_ID } }, res);
    expect(res.statusCode).toBe(403);
  });
  test('invalid id → 400 (server-side validation, no lookup)', async () => {
    const res = mockRes();
    await termsController.renderAcceptanceDetail({ admin: { role: 'admin' }, params: { acceptanceId: 'not-an-id' } }, res);
    expect(res.statusCode).toBe(400);
    expect(AgreementAcceptance.findById).not.toHaveBeenCalled();
  });
  test('valid id but not found → 404', async () => {
    AgreementAcceptance.findById.mockReturnValue(chainLean(null));
    const res = mockRes();
    await termsController.renderAcceptanceDetail({ admin: { role: 'superadmin' }, params: { acceptanceId: VALID_ID } }, res);
    expect(res.statusCode).toBe(404);
  });
  test('admin + found → renders evidence detail (read-only)', async () => {
    AgreementAcceptance.findById.mockReturnValue(chainLean(ACC));
    const res = mockRes();
    await termsController.renderAcceptanceDetail({ admin: { role: 'admin', username: 'boss' }, params: { acceptanceId: VALID_ID } }, res);
    expect(res.rendered.view).toBe('agreement-detail');
    expect(res.rendered.data.evidence.id).toBe(VALID_ID);
    expect(res.rendered.data.evidence.agreement.content).toBe('FULL ENGLISH TERMS');
  });
});

describe('already-completed detection (only after OTP verify) + duplicate prevention', () => {
  const IC = { _id: 'admin1', name: 'Ravi', email: 'ravi@example.com', displayRole: 'State In-Charge', assignedState: 'UP', role: 'subeditor', isActive: true };

  test('verify-otp with a completed record → alreadyCompleted summary (revealed only post-verify)', async () => {
    Admin.findOne.mockReturnValue({ select: () => Promise.resolve(IC) });
    otpService.verifyOtp.mockResolvedValue({ ok: true, adminId: 'admin1' });
    AgreementAcceptance.findOne.mockReturnValue(chainSortLean(ACC));
    const res = mockRes();
    await agreementController.verifyOtp({ body: { email: 'ravi@example.com', otp: '123456' }, headers: {}, ip: '1.1.1.1' }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.alreadyCompleted).toBe(true);
    expect(res.body.summary.tncVersion).toBe('1.0.0');
    expect(res.cookies.agr_token).toBeTruthy();
  });

  test('wrong OTP → NO completion status leaked (400, no summary)', async () => {
    Admin.findOne.mockReturnValue({ select: () => Promise.resolve(IC) });
    otpService.verifyOtp.mockResolvedValue({ ok: false, reason: 'wrong' });
    const res = mockRes();
    await agreementController.verifyOtp({ body: { email: 'ravi@example.com', otp: '000000' }, headers: {}, ip: '1.1.1.1' }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.alreadyCompleted).toBeUndefined();
    expect(res.body.summary).toBeUndefined();
  });

  test('accept with an existing acceptance → no duplicate created', async () => {
    Admin.findById.mockReturnValue({ select: () => Promise.resolve(IC) });
    AgreementAcceptance.findOne.mockReturnValue(chainSortLean(ACC));
    const res = mockRes();
    await agreementController.accept({ agreement: { adminId: 'admin1', otpVerified: true }, body: { agree: true, typedName: 'Ravi' }, headers: {}, ip: '1.1.1.1' }, res);
    expect(res.body.alreadyCompleted).toBe(true);
    expect(AgreementAcceptance.create).not.toHaveBeenCalled();
  });
});
