'use strict';

/**
 * Reporter Security (Phase 1) services: payout / mobile link keys, "one person — many
 * accounts" grouping, the State In-Charge proposal lookup, the switches (all OFF by
 * default, fail-safe) and the app-login recorder.
 */

jest.mock('../models/Admin', () => ({ distinct: jest.fn(), find: jest.fn(), updateOne: jest.fn(() => Promise.resolve({})) }));
jest.mock('../models/WithdrawalRequest', () => ({ distinct: jest.fn(), find: jest.fn() }));
jest.mock('../models/DistrictAssignmentRequest', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/ReporterLoginEvent', () => ({ aggregate: jest.fn(), create: jest.fn(() => Promise.resolve({})) }));
jest.mock('../models/ReporterSecuritySettings', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/security/alertEngine', () => ({ record: jest.fn() }));

const Admin = require('../models/Admin');
const WithdrawalRequest = require('../models/WithdrawalRequest');
const DistrictAssignmentRequest = require('../models/DistrictAssignmentRequest');
const ReporterLoginEvent = require('../models/ReporterLoginEvent');
const ReporterSecuritySettings = require('../models/ReporterSecuritySettings');
const alertEngine = require('../services/security/alertEngine');
const links = require('../services/security/accountLinks');
const settings = require('../services/security/reporterSecuritySettings');
const recorder = require('../services/security/reporterLoginRecorder');

const q = (v) => ({ select: () => ({ lean: () => Promise.resolve(v), sort: () => ({ lean: () => Promise.resolve(v) }) }), lean: () => Promise.resolve(v) });

beforeEach(() => jest.clearAllMocks());

describe('link keys', () => {
  test('payout keys from a saved method / validated payload', () => {
    expect(links.payoutKey({ type: 'upi', upiId: ' Ravi.K@YBL ' })).toBe('upi:ravi.k@ybl');
    expect(links.payoutKey({ type: 'bank', accountNumber: '1234 5678 9012', ifsc: 'SBIN0001234' })).toBe('bank:123456789012');
    expect(links.payoutKey({ type: 'bank', accountNumber: '123' })).toBeNull();
    expect(links.payoutKey(null)).toBeNull();
  });

  test('payout keys from the text stored on past withdrawals (what reporters typed)', () => {
    expect(links.payoutKeysFromText('UPI: ravi.k@ybl')).toEqual(['upi:ravi.k@ybl']);
    expect(links.payoutKeysFromText('PhonePe: 9876543210@ybl')).toEqual(['upi:9876543210@ybl']); // an @-handle is UPI, not a bare number
    expect(links.payoutKeysFromText('PhonePe: 9876543210')).toEqual(['phonepe:9876543210']);
    expect(links.payoutKey({ type: 'phonepe', phoneNumber: '+91 98765 43210' })).toBe('phonepe:9876543210');
    expect(links.payoutKey({ type: 'phonepe', phoneNumber: '12345' })).toBeNull();
    expect(links.payoutKeysFromText('Bank — K Ravi · A/C 123456789012 · IFSC SBIN0001234 · SBI')).toEqual(['bank:123456789012']);
    expect(links.payoutKeysFromText('cash please')).toEqual([]);
  });

  test('mobile numbers compared on the last 10 digits; placeholders ignored', () => {
    expect(links.normMobile('+91 98765 43210')).toBe('9876543210');
    expect(links.normMobile('09876543210')).toBe('9876543210');
    expect(links.normMobile('0000000000')).toBe('');
    expect(links.normMobile('12345')).toBe('');
    expect(links.normMobile(null)).toBe('');
  });
});

describe('findLinksFor (withdrawal hold check)', () => {
  test('same UPI on another account (typed on a past withdrawal) and same mobile → both reasons', async () => {
    WithdrawalRequest.distinct.mockResolvedValue(['acctB']);
    Admin.distinct.mockResolvedValue([]);
    Admin.find.mockReturnValue(q([{ _id: 'acctC', mobileNumber: '+91-98765-43210' }, { _id: 'acctD', mobileNumber: '9123443210' }]));
    const out = await links.findLinksFor('acctA', { payoutKeys: ['upi:ravi@ybl'], mobile: '9876543210' });
    expect(out.linkedAdminIds.sort()).toEqual(['acctB', 'acctC']);
    expect(out.reasons.map((r) => r.label)).toEqual(['UPI ravi@ybl', 'Mobile 9876543210']);
    const [, query] = WithdrawalRequest.distinct.mock.calls[0];
    expect(query.adminId).toEqual({ $ne: 'acctA' });
    expect(query.$or[0]).toEqual({ payoutKey: 'upi:ravi@ybl' });
    expect(new RegExp(query.$or[1].paymentDetails.$regex, 'i').test('UPI: Ravi@ybl')).toBe(true);
    expect(new RegExp(query.$or[1].paymentDetails.$regex, 'i').test('UPI: xravi@ybl')).toBe(false); // not a different UPI
  });

  test('bank account match; nothing shared → no reasons', async () => {
    WithdrawalRequest.distinct.mockResolvedValue([]);
    Admin.distinct.mockResolvedValue(['acctE']);
    const out = await links.findLinksFor('acctA', { payoutKeys: ['bank:123456789012'], mobile: '' });
    expect(out.reasons).toEqual([{ kind: 'bank', label: 'Bank A/C 123456789012', adminIds: ['acctE'] }]);
    const [, bq] = WithdrawalRequest.distinct.mock.calls[0];
    expect(new RegExp(bq.$or[1].paymentDetails.$regex).test('Bank — X · A/C 123456789012 · IFSC SBIN0001234')).toBe(true);
    expect(new RegExp(bq.$or[1].paymentDetails.$regex).test('A/C 1234567890123')).toBe(false);

    WithdrawalRequest.distinct.mockResolvedValue([]);
    Admin.distinct.mockResolvedValue([]);
    expect((await links.findLinksFor('acctA', { payoutKeys: ['upi:solo@ybl'] })).linkedAdminIds).toEqual([]);
  });
});

describe('linkedGroups (red groups on the Reporter Security page)', () => {
  const oid = (s) => ({ toString: () => s, valueOf: () => s });
  test('accounts sharing a payout account group together (stronger than a shared mobile), with who proposed them', async () => {
    Admin.find.mockReturnValue(q([
      { _id: oid('A'), name: 'Stringer A', username: 'sa', role: 'editor', reporterTier: 'stringer', createdAt: new Date('2026-08-01') },
      { _id: oid('B'), name: 'Stringer B', username: 'sb', role: 'editor', reporterTier: 'stringer', createdAt: new Date('2026-08-10') },
      { _id: oid('C'), name: 'Stringer C', username: 'sc', role: 'editor', reporterTier: 'stringer', createdAt: new Date('2026-08-20'), payoutMethods: [{ type: 'upi', upiId: 'ravi@ybl' }] },
      { _id: oid('D'), name: 'Rep D', username: 'rd', role: 'editor', mobileNumber: '9876543210' },
      { _id: oid('E'), name: 'Rep E', username: 're', role: 'editor', mobileNumber: '+91 98765 43210' },
      { _id: oid('F'), name: 'Solo', username: 'solo', role: 'editor', mobileNumber: '9000000001' },
    ]));
    WithdrawalRequest.find.mockReturnValue(q([
      { adminId: 'A', paymentDetails: 'UPI: ravi@ybl', amount: 500, status: 'approved' },
      { adminId: 'B', paymentDetails: 'UPI: RAVI@ybl', amount: 500, status: 'approved' },
      { adminId: 'B', paymentDetails: 'UPI: ravi@ybl', amount: 500, status: 'pending' },
      { adminId: 'F', paymentDetails: 'UPI: solo@ybl', amount: 500, status: 'approved' },
    ]));
    ReporterLoginEvent.aggregate.mockResolvedValue([{ _id: 'A', at: new Date('2026-09-20'), city: 'Khammam', region: 'TG' }]);
    DistrictAssignmentRequest.find.mockReturnValue(q([{ reporterId: 'B', stateInchargeName: 'SIC Raju', status: 'approved' }]));

    const groups = await links.linkedGroups();
    expect(groups).toHaveLength(2);
    const [pay, mob] = groups;
    expect(pay).toMatchObject({ size: 3, strength: 'payout' });
    expect(pay.shared).toEqual([{ kind: 'upi', label: 'UPI ravi@ybl', accounts: 3 }]);
    expect(pay.members.map((m) => m.name)).toEqual(['Stringer A', 'Stringer B', 'Stringer C']); // oldest first
    expect(pay.members[0]).toMatchObject({ lastLoginPlace: 'Khammam, TG', withdrawals: 1, paid: 500 });
    expect(pay.members[1]).toMatchObject({ proposedBy: 'SIC Raju', withdrawals: 2, paid: 500 });
    expect(mob).toMatchObject({ size: 2, strength: 'mobile' });
    expect(mob.shared).toEqual([{ kind: 'mobile', label: 'Mobile 9876543210', accounts: 2 }]);
  });

  test('nobody shares anything → no groups', async () => {
    Admin.find.mockReturnValue(q([{ _id: oid('A'), username: 'a', role: 'editor', mobileNumber: '9000000001' }]));
    WithdrawalRequest.find.mockReturnValue(q([]));
    expect(await links.linkedGroups()).toEqual([]);
  });
});

describe('sicProposal (State In-Charge self-approval rule)', () => {
  test('inside the window: approved (by review date) or pending (by request date)', async () => {
    DistrictAssignmentRequest.findOne.mockReturnValue(q({ _id: 'r1', tier: 'stringer' }));
    const now = Date.parse('2026-09-25T00:00:00Z');
    expect(await links.sicProposal('sic1', 'rep1', 30, now)).toEqual({ _id: 'r1', tier: 'stringer' });
    const [query] = DistrictAssignmentRequest.findOne.mock.calls[0];
    expect(query).toMatchObject({ stateInchargeId: 'sic1', reporterId: 'rep1' });
    expect(query.$or[0].status).toBe('approved');
    expect(query.$or[0].reviewedAt.$gte.toISOString()).toBe('2026-08-26T00:00:00.000Z');
    expect(query.$or[1]).toMatchObject({ status: 'pending' });
  });
  test('window 0 = any time; missing ids → null', async () => {
    DistrictAssignmentRequest.findOne.mockReturnValue(q(null));
    await links.sicProposal('sic1', 'rep1', 0);
    expect(DistrictAssignmentRequest.findOne.mock.calls[0][0]).toEqual({ stateInchargeId: 'sic1', reporterId: 'rep1', status: { $in: ['approved', 'pending'] } });
    expect(await links.sicProposal('', 'rep1', 30)).toBeNull();
  });
});

describe('security switches', () => {
  beforeEach(() => settings._resetForTest());

  test('every rule is OFF by default (nothing saved yet)', async () => {
    ReporterSecuritySettings.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    expect(await settings.get()).toEqual({
      payoutLinkHold: false, sicSelfApprovalBlock: false, sicSelfApprovalWindowDays: 30,
      blockUnapprovedAppLogin: false, closeReporterPortal: false, reporterLoginRateLimit: false,
      // Phase 2 (need the updated app)
      singleDeviceLogin: false, singleDeviceStrict: false, requireGpsOnNews: false, minReporterAppVersion: '',
    });
  });

  test('a database error never switches rules ON (fail-safe)', async () => {
    ReporterSecuritySettings.findOne.mockReturnValue({ lean: () => Promise.reject(new Error('down')) });
    expect((await settings.get()).payoutLinkHold).toBe(false);
  });

  test('update writes only known switches and refreshes the cache', async () => {
    ReporterSecuritySettings.findOneAndUpdate.mockImplementation((f, u) => ({ lean: () => Promise.resolve({ ...u.$set }) }));
    const out = await settings.update({ payoutLinkHold: true, closeReporterPortal: 'true', evil: true, sicSelfApprovalWindowDays: '7' }, 'boss');
    const [, update] = ReporterSecuritySettings.findOneAndUpdate.mock.calls[0];
    expect(update.$set).toEqual({ updatedBy: 'boss', payoutLinkHold: true, closeReporterPortal: true, sicSelfApprovalWindowDays: 7 });
    expect(out).toMatchObject({ payoutLinkHold: true, closeReporterPortal: true, sicSelfApprovalWindowDays: 7, sicSelfApprovalBlock: false });
    expect(settings.current().payoutLinkHold).toBe(true);
  });

  test('the minimum app version is only accepted in a version shape', async () => {
    ReporterSecuritySettings.findOneAndUpdate.mockImplementation((f, u) => ({ lean: () => Promise.resolve({ ...u.$set }) }));
    await settings.update({ minReporterAppVersion: ' 2.0.30 ' }, 'boss');
    expect(ReporterSecuritySettings.findOneAndUpdate.mock.calls[0][1].$set.minReporterAppVersion).toBe('2.0.30');
    await settings.update({ minReporterAppVersion: 'latest' }, 'boss'); // rubbish is ignored
    expect(ReporterSecuritySettings.findOneAndUpdate.mock.calls[1][1].$set).not.toHaveProperty('minReporterAppVersion');
    await settings.update({ minReporterAppVersion: '' }, 'boss'); // empty = gate removed
    expect(ReporterSecuritySettings.findOneAndUpdate.mock.calls[2][1].$set.minReporterAppVersion).toBe('');
  });
});

describe('app login recorder', () => {
  const req = (over = {}) => ({
    headers: { 'user-agent': 'Dart/3.5 (dart:io)', 'x-device-id': 'abc-123!<script>', 'x-forwarded-for': '49.205.144.10' },
    connection: { remoteAddress: '49.205.144.10' }, body: { deviceModel: 'Redmi Note 12', appVersion: '2.0.29' }, ...over,
  });

  test('event: account, result, IP → place (offline), sanitised device id', () => {
    const ev = recorder.buildEvent(req(), { admin: { _id: 'a1', username: 'ravi', role: 'editor' }, success: true, reason: 'ok' });
    expect(ev).toMatchObject({ adminId: 'a1', username: 'ravi', role: 'editor', success: true, reason: 'ok', source: 'app', ip: '49.205.144.10',
      userAgent: 'Dart/3.5 (dart:io)', deviceId: 'abc-123script', deviceModel: 'Redmi Note 12', appVersion: '2.0.29' });
    expect(ev.country).toBe('IN');
  });

  test('success → login event + lastLogin + login history (last 10); wrong password → brute-force detector', async () => {
    const admin = { _id: 'a1', username: 'ravi', role: 'editor' };
    const ok = recorder.buildEvent(req(), { admin, success: true, reason: 'ok' });
    await recorder.write(ok, admin);
    expect(ReporterLoginEvent.create).toHaveBeenCalledWith(ok);
    const [filter, update] = Admin.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'a1' });
    expect(update.$set.lastLogin).toBe(ok.at);
    expect(update.$push.loginHistory.$slice).toBe(-10);
    expect(update.$push.loginHistory.$each[0].location).toMatch(/\(app\)$/);

    const bad = recorder.buildEvent(req(), { admin, success: false, reason: 'bad_password' });
    await recorder.write(bad, admin);
    expect(alertEngine.record).toHaveBeenCalledWith(expect.objectContaining({ type: 'login_failed', account: 'ravi', ip: '49.205.144.10' }));
    expect(Admin.updateOne).toHaveBeenCalledTimes(1); // failures don't touch the account
  });

  test('recordAppLogin never throws, even on a broken request', () => {
    expect(() => recorder.recordAppLogin(null, { success: false })).not.toThrow();
  });
});
