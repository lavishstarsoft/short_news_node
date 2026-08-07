'use strict';

/**
 * View Distribution Engine — integration tests with mocked models.
 * Covers: ledger-first idempotency, dryRun (skip News writes), and rollback
 * (idempotent, clamped, syntheticViews-only, retry-safe, active-guard).
 * No live DB/Redis — the Mongoose models are mocked.
 */

const mongoose = require('mongoose');

jest.mock('../models/News', () => ({ bulkWrite: jest.fn() }));
jest.mock('../services/viewDistribution/models/ViewCampaign', () => ({ findById: jest.fn() }));
jest.mock('../services/viewDistribution/models/ViewDistributionState', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
  updateMany: jest.fn(),
  bulkWrite: jest.fn()
}));
jest.mock('../services/viewDistribution/models/ViewCycleLog', () => ({
  create: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn()
}));

const News = require('../models/News');
const ViewCampaign = require('../services/viewDistribution/models/ViewCampaign');
const ViewDistributionState = require('../services/viewDistribution/models/ViewDistributionState');
const ViewCycleLog = require('../services/viewDistribution/models/ViewCycleLog');
const applier = require('../services/viewDistribution/applier');
const rollback = require('../services/viewDistribution/rollback');

const oid = () => new mongoose.Types.ObjectId().toString();
const findLean = (docs) => ({ select: () => ({ lean: () => Promise.resolve(docs) }) });

beforeEach(() => {
  jest.clearAllMocks();
  News.bulkWrite.mockResolvedValue({ modifiedCount: 1, upsertedCount: 0, insertedCount: 0 });
  ViewDistributionState.bulkWrite.mockResolvedValue({ modifiedCount: 1 });
  ViewDistributionState.updateMany.mockResolvedValue({ modifiedCount: 1 });
});

function activeCampaign(extra = {}) {
  const now = Date.now();
  return {
    _id: oid(),
    status: 'active',
    durationMinutes: 60,
    rebalanceIntervalSec: 300,
    startAt: new Date(now - 7 * 60000),
    curve: { burstAlpha: 2, taperBeta: 3, jitterPct: 0.15, maxStepMultiplier: 4 },
    cooldown: { enabled: true, restCycles: 2 },
    save: jest.fn().mockResolvedValue(true),
    ...extra
  };
}

describe('applier — dryRun', () => {
  test('dryRun logs the ledger but does NOT write News', async () => {
    const campaign = activeCampaign({ dryRun: true });
    ViewCampaign.findById.mockResolvedValue(campaign);
    ViewDistributionState.countDocuments.mockResolvedValue(5); // >0 => no rebalance
    ViewDistributionState.find.mockReturnValue(findLean([
      { newsId: oid(), cap: 2000, floor: 1000, deliveredTotal: 0, cooldownUntilCycle: 0, bucket: {} }
    ]));
    ViewCycleLog.create.mockResolvedValue({});

    const res = await applier.processCycle({ campaignId: campaign._id, cycleIndex: 7 });

    expect(res.status).toBe('dry_run');
    expect(ViewCycleLog.create).toHaveBeenCalledTimes(1);
    expect(ViewCycleLog.create.mock.calls[0][0].dryRun).toBe(true);
    expect(News.bulkWrite).not.toHaveBeenCalled(); // organic + synthetic untouched
  });
});

describe('applier — ledger-first idempotency', () => {
  test('duplicate cycle (11000) => no News write, status duplicate', async () => {
    const campaign = activeCampaign({ dryRun: false });
    ViewCampaign.findById.mockResolvedValue(campaign);
    ViewDistributionState.countDocuments.mockResolvedValue(5);
    ViewDistributionState.find.mockReturnValue(findLean([
      { newsId: oid(), cap: 2000, floor: 1000, deliveredTotal: 0, cooldownUntilCycle: 0, bucket: {} }
    ]));
    ViewCycleLog.create.mockRejectedValue({ code: 11000 }); // unique index hit

    const res = await applier.processCycle({ campaignId: campaign._id, cycleIndex: 7 });

    expect(res.status).toBe('duplicate');
    expect(News.bulkWrite).not.toHaveBeenCalled(); // exactly-once: no double apply
  });

  test('applied cycle $inc syntheticViews only (never views)', async () => {
    const campaign = activeCampaign({ dryRun: false });
    ViewCampaign.findById.mockResolvedValue(campaign);
    ViewDistributionState.countDocuments.mockResolvedValue(5);
    ViewDistributionState.find.mockReturnValue(findLean([
      { newsId: oid(), cap: 2000, floor: 1000, deliveredTotal: 0, cooldownUntilCycle: 0, bucket: {} }
    ]));
    ViewCycleLog.create.mockResolvedValue({});

    const res = await applier.processCycle({ campaignId: campaign._id, cycleIndex: 7 });

    expect(res.status).toBe('applied');
    expect(News.bulkWrite).toHaveBeenCalledTimes(1);
    const ops = News.bulkWrite.mock.calls[0][0];
    ops.forEach((op) => {
      expect(op.updateOne.update.$inc.syntheticViews).toBeGreaterThan(0);
      expect(op.updateOne.update.$inc.views).toBeUndefined(); // organic never touched
    });
  });
});

describe('rollback — reverse', () => {
  test('reverses one cycle: clamped $max on syntheticViews only, marks reversed', async () => {
    const campaign = { _id: oid(), status: 'paused', save: jest.fn().mockResolvedValue(true) };
    ViewCampaign.findById.mockResolvedValue(campaign);
    const n1 = oid();
    const cycle = { _id: oid(), perItemDeltas: [{ newsId: n1, delta: 50 }] };
    // first claim returns a cycle, second returns null (done)
    ViewCycleLog.findOneAndUpdate.mockResolvedValueOnce(cycle).mockResolvedValue(null);

    const r = await rollback.reverseCampaign(campaign._id);

    expect(r.ok).toBe(true);
    expect(r.cyclesReversed).toBe(1);
    expect(r.totalReversed).toBe(50);
    // claim query excludes dryRun cycles and unreversed only
    const claimFilter = ViewCycleLog.findOneAndUpdate.mock.calls[0][0];
    expect(claimFilter.reversedAt).toBeNull();
    expect(claimFilter.dryRun).toEqual({ $ne: true });
    // clamped subtract on syntheticViews, not views
    const ops = News.bulkWrite.mock.calls[0][0];
    const set = ops[0].updateOne.update[0].$set;
    expect(set.syntheticViews.$max[0]).toBe(0);
    expect(JSON.stringify(set)).toContain('$syntheticViews');
    expect(JSON.stringify(set)).not.toContain('$views"'); // no organic field
    expect(campaign.status).toBe('reversed');
    expect(campaign.save).toHaveBeenCalled();
  });

  test('idempotent re-run: nothing left to reverse => no News writes', async () => {
    const campaign = { _id: oid(), status: 'reversed', save: jest.fn() };
    ViewCampaign.findById.mockResolvedValue(campaign);
    ViewCycleLog.findOneAndUpdate.mockResolvedValue(null); // all already reversed

    const r = await rollback.reverseCampaign(campaign._id);

    expect(r.ok).toBe(true);
    expect(r.cyclesReversed).toBe(0);
    expect(News.bulkWrite).not.toHaveBeenCalled();
  });

  test('active campaign is guarded', async () => {
    ViewCampaign.findById.mockResolvedValue({ _id: oid(), status: 'active' });
    const r = await rollback.reverseCampaign('x');
    expect(r).toEqual({ ok: false, error: 'active_must_pause_first' });
    expect(News.bulkWrite).not.toHaveBeenCalled();
  });

  test('not found', async () => {
    ViewCampaign.findById.mockResolvedValue(null);
    const r = await rollback.reverseCampaign('x');
    expect(r).toEqual({ ok: false, error: 'not_found' });
  });

  test('retry-safe: apply error releases the claim (reversedAt -> null) and throws', async () => {
    const campaign = { _id: oid(), status: 'paused', save: jest.fn() };
    ViewCampaign.findById.mockResolvedValue(campaign);
    const cycle = { _id: oid(), perItemDeltas: [{ newsId: oid(), delta: 10 }] };
    ViewCycleLog.findOneAndUpdate.mockResolvedValueOnce(cycle).mockResolvedValue(null);
    News.bulkWrite.mockRejectedValueOnce(new Error('db down'));
    ViewCycleLog.updateOne.mockResolvedValue({});

    await expect(rollback.reverseCampaign(campaign._id)).rejects.toThrow('db down');
    expect(ViewCycleLog.updateOne).toHaveBeenCalledWith(
      { _id: cycle._id },
      { $set: { reversedAt: null } }
    );
  });
});
