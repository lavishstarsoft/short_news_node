'use strict';

/**
 * P3 — handleApprovalEarning routing: tiered reporters get the per-news reward and
 * NOT the daily bonus; reporterTier=null keeps the existing daily-bonus path.
 * Guarantees no reporter can receive both.
 */

const mongoose = require('mongoose');

jest.mock('../utils/dailyRewardService', () => ({ evaluateDailyReward: jest.fn() }));
jest.mock('../utils/walletHelpers', () => ({
  checkAndCreditWallet: jest.fn().mockResolvedValue(),
  processWalletTransaction: jest.fn().mockResolvedValue({}),
}));
jest.mock('../utils/tierRewardService', () => {
  const actual = jest.requireActual('../utils/tierRewardService');
  return { ...actual, creditApprovedNewsReward: jest.fn() };
});
jest.mock('../models/LateApprovalEarning', () => ({
  findOne: jest.fn(() => ({ lean: () => Promise.resolve(null) })),
}));

const { evaluateDailyReward } = require('../utils/dailyRewardService');
const { checkAndCreditWallet } = require('../utils/walletHelpers');
const { creditApprovedNewsReward } = require('../utils/tierRewardService');
const { handleApprovalEarning } = require('../services/earning/lateApprovalService');

beforeEach(() => {
  evaluateDailyReward.mockReset();
  checkAndCreditWallet.mockClear();
  creditApprovedNewsReward.mockReset();
});

test('tiered reporter (stringer) → per-news reward, daily bonus NOT credited', async () => {
  evaluateDailyReward.mockResolvedValue({
    found: true, enabled: true, eligible: true, alreadyCredited: false,
    admin: { role: 'editor', reporterTier: 'stringer' },
    referenceId: 'reward_x', dateKey: '2026-08-22', maxReward: 30,
  });
  creditApprovedNewsReward.mockResolvedValue({ action: 'credited', amount: 5 });

  const n = { _id: new mongoose.Types.ObjectId(), authorId: 'rep1' };
  const res = await handleApprovalEarning({ news: n, approvedAt: n._id.getTimestamp(), approver: { id: 's1', name: 'SIC', role: 'subeditor' } });

  expect(res.action).toBe('credited');
  expect(creditApprovedNewsReward).toHaveBeenCalledTimes(1);
  expect(checkAndCreditWallet).not.toHaveBeenCalled(); // no daily bonus for tiered
});

test('reporterTier=null → unchanged daily-bonus path, per-news NOT called', async () => {
  const submission = new mongoose.Types.ObjectId();
  evaluateDailyReward.mockResolvedValue({
    found: true, enabled: true, eligible: true, alreadyCredited: false,
    admin: { role: 'editor', reporterTier: null },
    referenceId: 'reward_y', dateKey: '2026-08-22', maxReward: 30,
  });

  const n = { _id: submission, authorId: 'rep2' };
  await handleApprovalEarning({ news: n, approvedAt: submission.getTimestamp(), approver: { id: 's1', name: 'SIC', role: 'subeditor' } });

  expect(creditApprovedNewsReward).not.toHaveBeenCalled(); // tiered path not taken
  expect(checkAndCreditWallet).toHaveBeenCalledTimes(1);    // existing daily bonus preserved
});

test('sub-editor with no tier → daily-bonus path unchanged (per-news not called)', async () => {
  const submission = new mongoose.Types.ObjectId();
  evaluateDailyReward.mockResolvedValue({
    found: true, enabled: true, eligible: true, alreadyCredited: false,
    admin: { role: 'subeditor', reporterTier: null },
    referenceId: 'reward_z', dateKey: '2026-08-22', maxReward: 30,
  });

  const n = { _id: submission, authorId: 'sub1' };
  await handleApprovalEarning({ news: n, approvedAt: submission.getTimestamp(), approver: { id: 's1', name: 'SIC', role: 'subeditor' } });

  expect(creditApprovedNewsReward).not.toHaveBeenCalled();
  expect(checkAndCreditWallet).toHaveBeenCalledTimes(1);
});
