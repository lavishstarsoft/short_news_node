'use strict';

/**
 * P6 — updateWalletSettings tier-rate handling: Super Admin only, validated,
 * audited before→after. Non-super-admins cannot change the rates.
 */

jest.mock('node-fetch', () => jest.fn());
jest.mock('../config/redis', () => ({ redisClient: {}, isRedisAvailable: () => false }));
jest.mock('../services/oneSignalService', () => ({}));
jest.mock('../middleware/cache', () => ({ clearCache: jest.fn() }));

const settingsDoc = {};
const mockSave = jest.fn(async () => settingsDoc);
jest.mock('../models/AppSettings', () => {
  const Ctor = jest.fn(function () { Object.assign(this, settingsDoc); this.save = mockSave; });
  Ctor.findOne = jest.fn(async () => settingsDoc);
  return Ctor;
});

const mockLogAudit = jest.fn();
jest.mock('../utils/auditLogger', () => ({ logAudit: (...a) => mockLogAudit(...a) }));

const adminController = require('../controllers/adminController');

function res() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const baseBody = { reporterTargetNews: 5, reporterMaxDailyReward: 30, fixedWithdrawalAmount: 500 };

beforeEach(() => {
  for (const k of Object.keys(settingsDoc)) delete settingsDoc[k];
  settingsDoc._id = 'settings1';
  settingsDoc.stringerRatePerNews = 5;
  settingsDoc.districtInchargeRatePerNews = 10;
  settingsDoc.save = mockSave;
  mockSave.mockClear();
  mockLogAudit.mockClear();
});

test('Super Admin sets rates 10/20 → saved + audited before→after', async () => {
  const r = res();
  await adminController.updateWalletSettings(
    { admin: { role: 'superadmin' }, body: { ...baseBody, stringerRatePerNews: 10, districtInchargeRatePerNews: 20 } }, r
  );
  expect(r.body.success).toBe(true);
  expect(settingsDoc.stringerRatePerNews).toBe(10);
  expect(settingsDoc.districtInchargeRatePerNews).toBe(20);
  expect(r.body.stringerRatePerNews).toBe(10);
  expect(r.body.districtInchargeRatePerNews).toBe(20);
  const audit = mockLogAudit.mock.calls[0][0];
  expect(audit.before.stringerRatePerNews).toBe(5);
  expect(audit.after.stringerRatePerNews).toBe(10);
  expect(audit.after.districtInchargeRatePerNews).toBe(20);
});

test('Non-super-admin cannot change rates (ignored, other settings still save)', async () => {
  const r = res();
  await adminController.updateWalletSettings(
    { admin: { role: 'admin' }, body: { ...baseBody, stringerRatePerNews: 999, districtInchargeRatePerNews: 999 } }, r
  );
  expect(r.body.success).toBe(true);
  expect(settingsDoc.stringerRatePerNews).toBe(5);   // unchanged
  expect(settingsDoc.districtInchargeRatePerNews).toBe(10);
});

test('Super Admin invalid rate (negative) → 400, nothing saved', async () => {
  const r = res();
  await adminController.updateWalletSettings(
    { admin: { role: 'superadmin' }, body: { ...baseBody, stringerRatePerNews: -1 } }, r
  );
  expect(r.code).toBe(400);
  expect(mockSave).not.toHaveBeenCalled();
});

test('Super Admin rate above sane bound → 400', async () => {
  const r = res();
  await adminController.updateWalletSettings(
    { admin: { role: 'superadmin' }, body: { ...baseBody, districtInchargeRatePerNews: 100001 } }, r
  );
  expect(r.code).toBe(400);
  expect(mockSave).not.toHaveBeenCalled();
});

test('rate 0 is valid (pauses reward) for Super Admin', async () => {
  const r = res();
  await adminController.updateWalletSettings(
    { admin: { role: 'superadmin' }, body: { ...baseBody, stringerRatePerNews: 0 } }, r
  );
  expect(r.body.success).toBe(true);
  expect(settingsDoc.stringerRatePerNews).toBe(0);
});
