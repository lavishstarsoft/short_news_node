'use strict';

/**
 * P3 — Per-approved-news reward for tiered reporters.
 * Core crediting logic + the handleApprovalEarning branch (tiered → per-news,
 * null → unchanged daily bonus, never both).
 */

const mongoose = require('mongoose');

// ── Mock the wallet infra + models used by tierRewardService ────────────────
const mockExists = jest.fn();
jest.mock('../models/AdminWalletTransaction', () => ({ exists: mockExists }));
const mockCountDocuments = jest.fn();
jest.mock('../models/News', () => ({ countDocuments: mockCountDocuments }));
const mockProcessTx = jest.fn();
jest.mock('../utils/walletHelpers', () => ({ processWalletTransaction: mockProcessTx }));
// P6 — live rates come from AppSettings; null → fall back to defaults 5/10.
let mockSettings = null;
jest.mock('../models/AppSettings', () => ({
  findOne: () => ({ select: () => ({ lean: async () => mockSettings }) }),
}));

const { creditApprovedNewsReward, tierRate, resolveTierRate, buildNewsRewardReferenceId } = require('../utils/tierRewardService');

const news = () => ({ _id: new mongoose.Types.ObjectId(), authorId: 'rep1' });

beforeEach(() => {
  mockExists.mockReset().mockResolvedValue(false);
  mockCountDocuments.mockReset().mockResolvedValue(1);
  mockProcessTx.mockReset().mockResolvedValue({});
  mockSettings = null; // default rates
});

describe('tierRate', () => {
  test('stringer=5, district_incharge=10, everything else=0', () => {
    expect(tierRate('stringer')).toBe(5);
    expect(tierRate('district_incharge')).toBe(10);
    expect(tierRate(null)).toBe(0);
    expect(tierRate(undefined)).toBe(0);
    expect(tierRate('Reporter')).toBe(0);
  });
});

describe('creditApprovedNewsReward', () => {
  test('stringer approved news 1..10 → ₹5 each', async () => {
    for (let rank = 1; rank <= 10; rank++) {
      mockExists.mockResolvedValueOnce(false);
      mockCountDocuments.mockResolvedValueOnce(rank);
      const n = news();
      const r = await creditApprovedNewsReward({ news: n, reporterAdmin: { reporterTier: 'stringer' } });
      expect(r.action).toBe('credited');
      expect(r.amount).toBe(5);
      const call = mockProcessTx.mock.calls[mockProcessTx.mock.calls.length - 1][0];
      expect(call.amount).toBe(5);
      expect(call.type).toBe('credit');
      expect(call.adminId).toBe('rep1');
      expect(call.referenceId).toBe(buildNewsRewardReferenceId(n._id));
    }
    expect(mockProcessTx).toHaveBeenCalledTimes(10);
  });

  test('district_incharge approved news 1..10 → ₹10 each', async () => {
    for (let rank = 1; rank <= 10; rank++) {
      mockExists.mockResolvedValueOnce(false);
      mockCountDocuments.mockResolvedValueOnce(rank);
      const r = await creditApprovedNewsReward({ news: news(), reporterAdmin: { reporterTier: 'district_incharge' } });
      expect(r.action).toBe('credited');
      expect(r.amount).toBe(10);
    }
    expect(mockProcessTx).toHaveBeenCalledTimes(10);
  });

  test('11th approved news of the day → ₹0 (cap), no wallet write', async () => {
    mockCountDocuments.mockResolvedValueOnce(11);
    const r = await creditApprovedNewsReward({ news: news(), reporterAdmin: { reporterTier: 'stringer' } });
    expect(r.action).toBe('skipped');
    expect(r.reason).toBe('daily_cap_reached');
    expect(mockProcessTx).not.toHaveBeenCalled();
  });

  test('re-approval / retry → no duplicate credit (idempotent by referenceId)', async () => {
    mockExists.mockResolvedValueOnce(true); // this news already rewarded
    const r = await creditApprovedNewsReward({ news: news(), reporterAdmin: { reporterTier: 'stringer' } });
    expect(r.action).toBe('skipped');
    expect(r.reason).toBe('already_credited');
    expect(mockProcessTx).not.toHaveBeenCalled();
  });

  test('non-tiered reporter (null) → ₹0, no wallet write', async () => {
    const r = await creditApprovedNewsReward({ news: news(), reporterAdmin: { reporterTier: null } });
    expect(r.action).toBe('skipped');
    expect(r.reason).toBe('not_tiered');
    expect(mockProcessTx).not.toHaveBeenCalled();
    expect(mockExists).not.toHaveBeenCalled();
  });

  test('unique-index race on credit → treated as already credited, no throw', async () => {
    mockProcessTx.mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    const r = await creditApprovedNewsReward({ news: news(), reporterAdmin: { reporterTier: 'stringer' } });
    expect(r.action).toBe('skipped');
    expect(r.reason).toBe('race_dedup');
  });
});

// ── P6 — dynamic AppSettings rates ──────────────────────────────────────────
describe('resolveTierRate (live AppSettings)', () => {
  test('no settings → defaults 5/10', async () => {
    mockSettings = null;
    expect(await resolveTierRate('stringer')).toBe(5);
    expect(await resolveTierRate('district_incharge')).toBe(10);
    expect(await resolveTierRate(null)).toBe(0);
  });
  test('custom settings 10/20 → used', async () => {
    mockSettings = { stringerRatePerNews: 10 };
    expect(await resolveTierRate('stringer')).toBe(10);
    mockSettings = { districtInchargeRatePerNews: 20 };
    expect(await resolveTierRate('district_incharge')).toBe(20);
  });
  test('invalid/negative field → falls back to default', async () => {
    mockSettings = { stringerRatePerNews: -3 };
    expect(await resolveTierRate('stringer')).toBe(5);
    mockSettings = { stringerRatePerNews: 'abc' };
    expect(await resolveTierRate('stringer')).toBe(5);
  });
});

describe('creditApprovedNewsReward — dynamic rate applied at approval', () => {
  test('Stringer credits the configured ₹10 when settings say 10', async () => {
    mockSettings = { stringerRatePerNews: 10 };
    await creditApprovedNewsReward({ news: news(), reporterAdmin: { reporterTier: 'stringer' } });
    expect(mockProcessTx.mock.calls[0][0].amount).toBe(10);
  });
  test('District In-Charge credits configured ₹20 when settings say 20', async () => {
    mockSettings = { districtInchargeRatePerNews: 20 };
    await creditApprovedNewsReward({ news: news(), reporterAdmin: { reporterTier: 'district_incharge' } });
    expect(mockProcessTx.mock.calls[0][0].amount).toBe(20);
  });
  test('rate 0 → skipped (zero_rate), no wallet write', async () => {
    mockSettings = { stringerRatePerNews: 0 };
    const r = await creditApprovedNewsReward({ news: news(), reporterAdmin: { reporterTier: 'stringer' } });
    expect(r.action).toBe('skipped');
    expect(r.reason).toBe('zero_rate');
    expect(mockProcessTx).not.toHaveBeenCalled();
  });
  test('cap still enforced with custom rate (11th → ₹0)', async () => {
    mockSettings = { stringerRatePerNews: 10 };
    mockCountDocuments.mockResolvedValueOnce(11);
    const r = await creditApprovedNewsReward({ news: news(), reporterAdmin: { reporterTier: 'stringer' } });
    expect(r.action).toBe('skipped');
    expect(r.reason).toBe('daily_cap_reached');
  });
});
