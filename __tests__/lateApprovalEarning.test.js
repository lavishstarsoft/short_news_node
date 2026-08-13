'use strict';

/**
 * lateApprovalService — late/next-day approval hold + idempotent Super-Admin release.
 * Real IST helper; models & wallet mocked. Verifies the reporter is never penalized
 * and never double-credited across midnight.
 */

jest.mock('../models/LateApprovalEarning', () => ({ findOne: jest.fn(), create: jest.fn(), findById: jest.fn(), countDocuments: jest.fn(() => Promise.resolve(1)) }));
jest.mock('../utils/dailyRewardService', () => ({ evaluateDailyReward: jest.fn() }));
jest.mock('../utils/walletHelpers', () => ({ checkAndCreditWallet: jest.fn(() => Promise.resolve()), processWalletTransaction: jest.fn(() => Promise.resolve({})) }));
jest.mock('../models/AdminWalletTransaction', () => ({ exists: jest.fn(() => Promise.resolve(false)) }));
jest.mock('../models/Admin', () => ({ find: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve([]) }) })) }));
jest.mock('../models/Notification', () => ({ create: jest.fn(() => Promise.resolve({})) }));
jest.mock('../models/AuditLog', () => ({ create: jest.fn(() => Promise.resolve({})) }));
jest.mock('../services/security/alertEngine', () => ({ record: jest.fn() }));

const LateApprovalEarning = require('../models/LateApprovalEarning');
const dailyReward = require('../utils/dailyRewardService');
const wallet = require('../utils/walletHelpers');
const AdminWalletTransaction = require('../models/AdminWalletTransaction');
const svc = require('../services/earning/lateApprovalService');

// IST = UTC+5:30. These UTC instants map to the wanted IST wall-clock times.
const SUBMIT_1130PM_AUG9 = new Date('2026-08-09T18:00:00Z'); // 2026-08-09 23:30 IST
const APPROVE_1201AM_AUG10 = new Date('2026-08-09T18:31:00Z'); // 2026-08-10 00:01 IST
const APPROVE_SAMEDAY = new Date('2026-08-09T18:10:00Z'); // 2026-08-09 23:40 IST

const news = { _id: { getTimestamp: () => SUBMIT_1130PM_AUG9 }, authorId: 'rep1' };
const rewardEligible = { found: true, admin: { role: 'editor', username: 'Rep' }, enabled: true, eligible: true, alreadyCredited: false, referenceId: 'reward_rep1_2026-08-09', dateKey: '2026-08-09', maxReward: 30, targetNews: 5 };
const noHold = () => ({ lean: () => Promise.resolve(null) });

beforeEach(() => {
  jest.clearAllMocks();
  LateApprovalEarning.findOne.mockReturnValue(noHold());
  LateApprovalEarning.create.mockResolvedValue({ _id: 'lae1', ...rewardEligible, reporterId: 'rep1', reporterName: 'Rep', newsId: 'n1', stateInchargeId: 'ic1', stateInchargeName: 'Praveen', submittedAt: SUBMIT_1130PM_AUG9, approvedAt: APPROVE_1201AM_AUG10, approvalDelayMinutes: 31, earningAmount: 30, dateKey: '2026-08-09' });
});

describe('isLate (midnight boundary)', () => {
  test('11:30 PM Aug 9 → 12:01 AM Aug 10 is LATE', () => {
    expect(svc.isLate(SUBMIT_1130PM_AUG9, APPROVE_1201AM_AUG10)).toBe(true);
  });
  test('same-day approval is NOT late', () => {
    expect(svc.isLate(SUBMIT_1130PM_AUG9, APPROVE_SAMEDAY)).toBe(false);
  });
  test('delay is measured in minutes', () => {
    expect(svc.delayMinutes(SUBMIT_1130PM_AUG9, APPROVE_1201AM_AUG10)).toBe(31);
  });
});

describe('handleApprovalEarning', () => {
  test('SAME-DAY eligible → credits immediately, no hold', async () => {
    dailyReward.evaluateDailyReward.mockResolvedValue(rewardEligible);
    const r = await svc.handleApprovalEarning({ news, approvedAt: APPROVE_SAMEDAY, approver: { id: 'ic1', name: 'Praveen', role: 'subeditor' } });
    expect(r.action).toBe('credited');
    expect(wallet.checkAndCreditWallet).toHaveBeenCalledTimes(1);
    expect(LateApprovalEarning.create).not.toHaveBeenCalled();
  });

  test('LATE + eligible → HOLDS the day-reward, does NOT credit', async () => {
    dailyReward.evaluateDailyReward.mockResolvedValue(rewardEligible);
    const r = await svc.handleApprovalEarning({ news, approvedAt: APPROVE_1201AM_AUG10, approver: { id: 'ic1', name: 'Praveen', role: 'subeditor' } });
    expect(r.action).toBe('held');
    expect(wallet.checkAndCreditWallet).not.toHaveBeenCalled();
    const created = LateApprovalEarning.create.mock.calls[0][0];
    expect(created.referenceId).toBe('reward_rep1_2026-08-09'); // reward tied to SUBMISSION day
    expect(created.earningAmount).toBe(30); // unchanged reward — reporter not penalized
    expect(created.lateApproval).toBe(true);
    expect(created.approvalDelayMinutes).toBe(31);
  });

  test('LATE but target not met yet → nothing held, nothing credited', async () => {
    dailyReward.evaluateDailyReward.mockResolvedValue({ ...rewardEligible, eligible: false });
    const r = await svc.handleApprovalEarning({ news, approvedAt: APPROVE_1201AM_AUG10, approver: { id: 'ic1' } });
    expect(r.action).toBe('skipped');
    expect(wallet.checkAndCreditWallet).not.toHaveBeenCalled();
    expect(LateApprovalEarning.create).not.toHaveBeenCalled();
  });

  test('already credited → no double earning', async () => {
    dailyReward.evaluateDailyReward.mockResolvedValue({ ...rewardEligible, alreadyCredited: true });
    const r = await svc.handleApprovalEarning({ news, approvedAt: APPROVE_1201AM_AUG10, approver: { id: 'ic1' } });
    expect(r.action).toBe('skipped');
    expect(LateApprovalEarning.create).not.toHaveBeenCalled();
  });

  test('LATE but a hold already exists → idempotent, no duplicate hold', async () => {
    dailyReward.evaluateDailyReward.mockResolvedValue(rewardEligible);
    LateApprovalEarning.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: 'lae1', referenceId: 'reward_rep1_2026-08-09' }) });
    const r = await svc.handleApprovalEarning({ news, approvedAt: APPROVE_1201AM_AUG10, approver: { id: 'ic1' } });
    expect(r.action).toBe('held');
    expect(LateApprovalEarning.create).not.toHaveBeenCalled();
  });
});

describe('releasePending (Super Admin, idempotent)', () => {
  function heldDoc() {
    return { _id: 'lae1', reporterId: 'rep1', reporterName: 'Rep', dateKey: '2026-08-09', referenceId: 'reward_rep1_2026-08-09', earningAmount: 30, earningStatus: 'pending_superadmin_review', earningReleasedAt: null, superAdminAction: {}, save: jest.fn(() => Promise.resolve()) };
  }
  const SUPER = { id: 'sa1', username: 'boss', role: 'superadmin' };

  test('release credits once and marks released', async () => {
    const doc = heldDoc();
    LateApprovalEarning.findById.mockResolvedValue(doc);
    const r = await svc.releasePending('lae1', SUPER);
    expect(r.ok).toBe(true);
    expect(wallet.processWalletTransaction).toHaveBeenCalledTimes(1);
    expect(wallet.processWalletTransaction.mock.calls[0][0]).toMatchObject({ adminId: 'rep1', amount: 30, type: 'credit', referenceId: 'reward_rep1_2026-08-09' });
    expect(doc.earningStatus).toBe('released');
    expect(doc.earningReleasedAt).toBeInstanceOf(Date);
  });

  test('double release → no second credit', async () => {
    const doc = { ...heldDoc(), earningStatus: 'released' };
    LateApprovalEarning.findById.mockResolvedValue(doc);
    const r = await svc.releasePending('lae1', SUPER);
    expect(r.already).toBe(true);
    expect(wallet.processWalletTransaction).not.toHaveBeenCalled();
  });

  test('release skips credit when a wallet tx already exists (unique referenceId)', async () => {
    const doc = heldDoc();
    LateApprovalEarning.findById.mockResolvedValue(doc);
    AdminWalletTransaction.exists.mockResolvedValue(true);
    const r = await svc.releasePending('lae1', SUPER);
    expect(r.ok).toBe(true);
    expect(wallet.processWalletTransaction).not.toHaveBeenCalled();
    expect(doc.earningStatus).toBe('released');
  });

  test('release of unknown record → not_found', async () => {
    LateApprovalEarning.findById.mockResolvedValue(null);
    const r = await svc.releasePending('nope', SUPER);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_found');
  });
});
