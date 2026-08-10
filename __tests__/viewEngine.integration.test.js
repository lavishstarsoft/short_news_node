'use strict';

/**
 * View Distribution Engine — integration tests with mocked models.
 * Covers: ledger-first idempotency, dryRun (skip News writes), and rollback
 * (idempotent, clamped, syntheticViews-only, retry-safe, active-guard).
 * No live DB/Redis — the Mongoose models are mocked.
 */

const mongoose = require('mongoose');

jest.mock('../models/News', () => ({ bulkWrite: jest.fn(), updateOne: jest.fn() }));
jest.mock('../services/viewDistribution/models/ViewCampaign', () => ({ findById: jest.fn() }));
jest.mock('../services/viewDistribution/models/ViewDistributionState', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
  updateMany: jest.fn(),
  updateOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  bulkWrite: jest.fn()
}));
jest.mock('../services/viewDistribution/models/ViewCycleLog', () => ({
  create: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn()
}));
jest.mock('../services/viewDistribution/signalProvider', () => ({ fetchCandidates: jest.fn() }));

const News = require('../models/News');
const ViewCampaign = require('../services/viewDistribution/models/ViewCampaign');
const ViewDistributionState = require('../services/viewDistribution/models/ViewDistributionState');
const ViewCycleLog = require('../services/viewDistribution/models/ViewCycleLog');
const applier = require('../services/viewDistribution/applier');
const rollback = require('../services/viewDistribution/rollback');
const signalProvider = require('../services/viewDistribution/signalProvider');
const windowApplier = require('../services/viewDistribution/windowApplier');

const oid = () => new mongoose.Types.ObjectId().toString();
const findLean = (docs) => ({ select: () => ({ lean: () => Promise.resolve(docs) }) });

/**
 * Keyset-aware find() mock for windowApplier: returns docs whose _id > q._id.$gt
 * in ascending _id order, capped at `limit`. Chain: find().select().sort().limit().lean().
 */
function keysetFind(allDocs) {
  return (q = {}) => {
    const gt = q && q._id && q._id.$gt;
    let rows = allDocs.slice();
    rows.sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
    if (gt != null) rows = rows.filter((d) => d._id > gt);
    let lim = rows.length;
    const chain = {
      select: () => chain,
      sort: () => chain,
      limit: (n) => { lim = n; return chain; },
      lean: () => Promise.resolve(rows.slice(0, lim))
    };
    return chain;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  News.bulkWrite.mockResolvedValue({ modifiedCount: 1, upsertedCount: 0, insertedCount: 0 });
  News.updateOne.mockResolvedValue({ modifiedCount: 1 });
  ViewDistributionState.bulkWrite.mockResolvedValue({ modifiedCount: 1 });
  ViewDistributionState.updateMany.mockResolvedValue({ modifiedCount: 1 });
  ViewDistributionState.updateOne.mockResolvedValue({ modifiedCount: 1 });
  signalProvider.fetchCandidates.mockResolvedValue([]); // default: no onboarding/rebalance
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

describe('windowApplier — keyset batching (per_news_window)', () => {
  const BATCH = 500;

  function windowCampaign(extra = {}) {
    const now = Date.now();
    return {
      _id: oid(),
      status: 'active',
      mode: 'per_news_window',
      dryRun: false,
      intervalMinutes: 60,
      minViews: 1000,
      maxViews: 2000,
      startAt: new Date(now - 5 * 60000),
      ...extra
    };
  }

  // n active states, each with headroom so this cycle produces a positive delta.
  function activeStates(n) {
    const started = new Date(Date.now() - 60000); // ~1 minute in => growing
    return Array.from({ length: n }, () => ({
      _id: oid(),
      newsId: oid(),
      cap: 1500,
      deliveredTotal: 0,
      startedAt: started,
      windowMinutes: 60,
      completedAt: null
    }));
  }

  beforeEach(() => {
    signalProvider.fetchCandidates.mockResolvedValue([]); // no onboarding noise
  });

  test('501 active news => 2 batches, distinct batchNo, News written per batch', async () => {
    const campaign = windowCampaign();
    ViewCampaign.findById.mockResolvedValue(campaign);
    ViewDistributionState.find.mockImplementation(keysetFind(activeStates(BATCH + 1)));
    ViewCycleLog.create.mockResolvedValue({});

    const res = await windowApplier.processCycle({ campaignId: campaign._id, cycleIndex: 3 });

    expect(res.status).toBe('applied');
    // one ledger row per batch, batchNo 0 then 1
    expect(ViewCycleLog.create).toHaveBeenCalledTimes(2);
    const batchNos = ViewCycleLog.create.mock.calls.map((c) => c[0].batchNo);
    expect(batchNos).toEqual([0, 1]);
    // every ledger row carries this cycleIndex + campaign
    ViewCycleLog.create.mock.calls.forEach((c) => {
      expect(c[0].cycleIndex).toBe(3);
      expect(String(c[0].campaignId)).toBe(String(campaign._id));
    });
    // News written once per batch, syntheticViews only
    expect(News.bulkWrite).toHaveBeenCalledTimes(2);
    News.bulkWrite.mock.calls.flatMap((c) => c[0]).forEach((op) => {
      expect(op.updateOne.update.$inc.syntheticViews).toBeGreaterThan(0);
      expect(op.updateOne.update.$inc.views).toBeUndefined();
    });
  });

  test('retry after partial: batch 0 already committed (11000) => only batch 1 applies', async () => {
    const campaign = windowCampaign();
    ViewCampaign.findById.mockResolvedValue(campaign);
    ViewDistributionState.find.mockImplementation(keysetFind(activeStates(BATCH + 1)));
    ViewCycleLog.create
      .mockRejectedValueOnce({ code: 11000 }) // batch 0 was done in the prior attempt
      .mockResolvedValue({});                  // batch 1 is fresh

    const res = await windowApplier.processCycle({ campaignId: campaign._id, cycleIndex: 4 });

    expect(res.status).toBe('applied');
    expect(ViewCycleLog.create).toHaveBeenCalledTimes(2);
    // batch 0 skipped => News written exactly once (batch 1 only) => no double $inc
    expect(News.bulkWrite).toHaveBeenCalledTimes(1);
    expect(res.itemsAffected).toBe(1);
  });

  test('full retry: every batch duplicate (11000) => no News writes at all', async () => {
    const campaign = windowCampaign();
    ViewCampaign.findById.mockResolvedValue(campaign);
    ViewDistributionState.find.mockImplementation(keysetFind(activeStates(BATCH + 1)));
    ViewCycleLog.create.mockRejectedValue({ code: 11000 });

    const res = await windowApplier.processCycle({ campaignId: campaign._id, cycleIndex: 5 });

    expect(ViewCycleLog.create).toHaveBeenCalledTimes(2); // both batches probed
    expect(res.itemsAffected).toBe(0);
    expect(News.bulkWrite).not.toHaveBeenCalled(); // idempotent: nothing re-applied
  });

  test('no active news => status no_active, no ledger, no writes', async () => {
    const campaign = windowCampaign();
    ViewCampaign.findById.mockResolvedValue(campaign);
    ViewDistributionState.find.mockImplementation(keysetFind([]));

    const res = await windowApplier.processCycle({ campaignId: campaign._id, cycleIndex: 6 });

    expect(res.status).toBe('no_active');
    expect(ViewCycleLog.create).not.toHaveBeenCalled();
    expect(News.bulkWrite).not.toHaveBeenCalled();
  });

  test('dryRun window cycle logs ledger but never writes News', async () => {
    const campaign = windowCampaign({ dryRun: true });
    ViewCampaign.findById.mockResolvedValue(campaign);
    ViewDistributionState.find.mockImplementation(keysetFind(activeStates(3)));
    ViewCycleLog.create.mockResolvedValue({});

    const res = await windowApplier.processCycle({ campaignId: campaign._id, cycleIndex: 7 });

    expect(res.status).toBe('dry_run');
    expect(ViewCycleLog.create).toHaveBeenCalledTimes(1);
    expect(News.bulkWrite).not.toHaveBeenCalled();
  });
});

describe('rollback — reverse (durable deliveredTotal, no ledger dependency)', () => {
  test('reverses one news via deliveredTotal: clamped $max on syntheticViews only, marks reversed', async () => {
    const campaign = { _id: oid(), status: 'paused', save: jest.fn().mockResolvedValue(true) };
    ViewCampaign.findById.mockResolvedValue(campaign);
    const n1 = oid();
    // first claim returns a state (deliveredTotal 50, zeroed), second returns null (done)
    ViewDistributionState.findOneAndUpdate
      .mockResolvedValueOnce({ _id: oid(), newsId: n1, deliveredTotal: 50 })
      .mockResolvedValue(null);

    const r = await rollback.reverseCampaign(campaign._id);

    expect(r.ok).toBe(true);
    expect(r.cyclesReversed).toBe(1);
    expect(r.totalReversed).toBe(50);
    // claim query: this campaign's states with deliveredTotal>0, zeroed atomically
    const claimFilter = ViewDistributionState.findOneAndUpdate.mock.calls[0][0];
    expect(claimFilter.deliveredTotal).toEqual({ $gt: 0 });
    expect(ViewDistributionState.findOneAndUpdate.mock.calls[0][1]).toEqual({ $set: { deliveredTotal: 0 } });
    // clamped subtract on syntheticViews only, never organic views; claim released
    const pipeline = News.updateOne.mock.calls[0][1];
    const set = pipeline[0].$set;
    expect(set.syntheticViews.$max[0]).toBe(0);
    expect(JSON.stringify(pipeline)).toContain('$syntheticViews');
    expect(JSON.stringify(pipeline)).not.toContain('$views"');
    expect(JSON.stringify(pipeline)).toContain('viewEngineCampaignId');
    expect(campaign.status).toBe('reversed');
    expect(campaign.save).toHaveBeenCalled();
  });

  test('idempotent re-run: nothing left (deliveredTotal all 0) => no News writes', async () => {
    const campaign = { _id: oid(), status: 'reversed', save: jest.fn() };
    ViewCampaign.findById.mockResolvedValue(campaign);
    ViewDistributionState.findOneAndUpdate.mockResolvedValue(null);

    const r = await rollback.reverseCampaign(campaign._id);

    expect(r.cyclesReversed).toBe(0);
    expect(News.updateOne).not.toHaveBeenCalled();
  });

  test('active campaign is guarded', async () => {
    ViewCampaign.findById.mockResolvedValue({ _id: oid(), status: 'active' });
    const r = await rollback.reverseCampaign('x');
    expect(r).toEqual({ ok: false, error: 'active_must_pause_first' });
    expect(News.updateOne).not.toHaveBeenCalled();
  });

  test('not found', async () => {
    ViewCampaign.findById.mockResolvedValue(null);
    const r = await rollback.reverseCampaign('x');
    expect(r).toEqual({ ok: false, error: 'not_found' });
  });

  test('retry-safe: subtract error restores the claimed deliveredTotal and throws', async () => {
    const campaign = { _id: oid(), status: 'paused', save: jest.fn() };
    ViewCampaign.findById.mockResolvedValue(campaign);
    const st = { _id: oid(), newsId: oid(), deliveredTotal: 10 };
    ViewDistributionState.findOneAndUpdate.mockResolvedValueOnce(st).mockResolvedValue(null);
    News.updateOne.mockRejectedValueOnce(new Error('db down'));

    await expect(rollback.reverseCampaign(campaign._id)).rejects.toThrow('db down');
    expect(ViewDistributionState.updateOne).toHaveBeenCalledWith(
      { _id: st._id },
      { $set: { deliveredTotal: 10 } }
    );
  });
});
