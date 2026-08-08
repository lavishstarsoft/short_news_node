'use strict';

/**
 * applier.js — the idempotent WRITE layer (the worker's handler).
 *
 * Per cycle it:
 *   1. (re)balances when due — signalProvider -> Strategy -> Allocator target bands
 *      (this is the adaptive "planner": builds/updates ViewDistributionState).
 *   2. computes per-item deltas via the Allocator.
 *   3. LEDGER-FIRST: inserts ViewCycleLog {campaignId, cycleIndex} whose UNIQUE
 *      index is the exactly-once guard. Duplicate key => cycle already applied =>
 *      no-op (idempotent). This runs BEFORE the News write.
 *   4. bulkWrite $inc on News.syntheticViews ONLY (never `views`). dryRun skips it.
 *   5. updates ViewDistributionState (deliveredTotal, cooldown, cursor).
 *
 * Transaction safety:
 *   This deployment has no MongoDB replica set, so multi-document transactions
 *   are unavailable. We therefore rely on LEDGER-FIRST ordering for exactly-once.
 *   A crash between (3) and (4) can leave the ledger claiming a delta that wasn't
 *   applied — but because delivery is TIME-ANCHORED (curve F(t)), the next cycle's
 *   expected-minus-delivered self-corrects the shortfall, and rollback clamps
 *   syntheticViews at 0. If a replica set is later enabled, steps (3)-(5) can be
 *   wrapped in a session/withTransaction at the marked seam with no API change.
 *
 * Guarantees: IDEMPOTENT, RETRY-SAFE, PM2-SAFE (unique ledger), batch-optimized
 * (unordered bulkWrite, chunked), ROLLBACK-READY (perItemDeltas ledger),
 * and it NEVER touches organic `views`.
 */

const mongoose = require('mongoose');
const News = require('../../models/News');
const ViewCampaign = require('./models/ViewCampaign');
const ViewDistributionState = require('./models/ViewDistributionState');
const ViewCycleLog = require('./models/ViewCycleLog');
const signalProvider = require('./signalProvider');
const allocator = require('./allocator');
require('./strategy/AdaptiveStrategy'); // self-registers the 'adaptive' strategy
const { resolveStrategy } = require('./strategy/AllocationStrategy');
const { LOG_PREFIX } = require('./constants');

const BULK_CHUNK = 1000;
const WORKER_ID = `${process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? ''}:${process.pid}`;

function toObjectId(id) {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch (_) {
    return null;
  }
}

/** Unordered, chunked bulkWrite — high throughput, never blocks on one bad op. */
async function bulkWriteChunked(Model, ops) {
  if (!ops || !ops.length) return { modified: 0, upserted: 0 };
  let modified = 0;
  let upserted = 0;
  for (let i = 0; i < ops.length; i += BULK_CHUNK) {
    const chunk = ops.slice(i, i + BULK_CHUNK);
    const res = await Model.bulkWrite(chunk, { ordered: false });
    modified += (res.modifiedCount || 0) + (res.insertedCount || 0);
    upserted += res.upsertedCount || 0;
  }
  return { modified, upserted };
}

/** Wall-clock timing for the curve (time-anchored, self-correcting). */
function computeTiming(campaign, now = Date.now()) {
  const start = campaign.startAt ? new Date(campaign.startAt).getTime() : now;
  const totalMs = Math.max(1, (Number(campaign.durationMinutes) || 0) * 60000);
  return { start, totalMs, elapsedMs: Math.max(0, now - start) };
}

function rebalanceCyclesOf(campaign) {
  return Math.max(1, Math.round((Number(campaign.rebalanceIntervalSec) || 300) / 60));
}

/** Whether this cycle should (re)balance target bands. */
function shouldRebalance(campaign, cycleIndex, stateCount) {
  if (!stateCount) return true; // first run: must build states
  return cycleIndex % rebalanceCyclesOf(campaign) === 0;
}

/**
 * Adaptive rebalance: (re)build ViewDistributionState target bands from current
 * signals. Upserts are safe to re-run (idempotent-ish): deliveredTotal/cooldown
 * are preserved via $set that excludes them.
 */
async function rebalance(campaign, cycleIndex, now) {
  const candidates = await signalProvider.fetchCandidates(campaign, now);
  if (!candidates.length) return 0;

  const existing = await ViewDistributionState.find({ campaignId: campaign._id })
    .select('newsId deliveredTotal cooldownUntilCycle cap organicBaseline lastRebalanceAt')
    .lean();
  const stateById = new Map(existing.map((s) => [String(s.newsId), s]));
  const priorStateById = new Map(
    existing.map((s) => [String(s.newsId), { organicBaseline: s.organicBaseline, lastRebalanceAt: s.lastRebalanceAt }])
  );

  const fvs = signalProvider.computeFeatureVectors(candidates, { now, priorStateById });

  // Safeguard inputs for the strategy (soft shaping).
  const cooldownByItem = {};
  const budgetByItem = {};
  for (const s of existing) {
    cooldownByItem[String(s.newsId)] = s.cooldownUntilCycle;
    budgetByItem[String(s.newsId)] = { remaining: Math.max(0, (s.cap || 0) - (s.deliveredTotal || 0)) };
  }

  const strategy = resolveStrategy(campaign.strategy || 'adaptive');
  const decision = strategy.decide(fvs, { campaign, cycleIndex, now, cooldownByItem, budgetByItem });

  const statesForAlloc = fvs.map((fv) => ({
    itemId: fv.itemId,
    deliveredTotal: (stateById.get(fv.itemId) || {}).deliveredTotal || 0,
    bucket: fv.bucket
  }));
  const bands = allocator.allocateTargets({ decision, states: statesForAlloc, campaign });
  const bandById = new Map(bands.map((b) => [b.itemId, b]));
  const fvById = new Map(fvs.map((f) => [f.itemId, f]));

  const ops = [];
  for (const doc of candidates) {
    const id = String(doc._id);
    const band = bandById.get(id);
    if (!band) continue;
    const fv = fvById.get(id);
    ops.push({
      updateOne: {
        filter: { campaignId: campaign._id, newsId: doc._id },
        update: {
          $set: {
            bucket: band.bucket,
            score: band.score,
            cap: band.cap,
            floor: band.floor,
            organicBaseline: fv ? fv.organicNow : (doc.views || 0),
            featureSnapshot: fv ? fv.features : null,
            lastRebalanceAt: now
          },
          $setOnInsert: { deliveredTotal: 0, cooldownUntilCycle: 0, lastCycleIndex: -1 }
        },
        upsert: true
      }
    });
  }
  await bulkWriteChunked(ViewDistributionState, ops);
  return ops.length;
}

/**
 * Apply one cycle: compute deltas, write ledger (idempotency), $inc synthetic, update state.
 */
async function applyCycle(campaign, cycleIndex, timing) {
  const states = await ViewDistributionState.find({ campaignId: campaign._id })
    .select('newsId cap floor deliveredTotal cooldownUntilCycle bucket')
    .lean();
  if (!states.length) return { status: 'no_states', cycleIndex };

  const stateInputs = states.map((s) => ({
    itemId: String(s.newsId),
    cap: s.cap,
    floor: s.floor,
    deliveredTotal: s.deliveredTotal,
    cooldownUntilCycle: s.cooldownUntilCycle,
    bucket: s.bucket
  }));

  const result = allocator.computeCycleDeltas({
    states: stateInputs,
    campaign,
    timing: { cycleIndex, elapsedMs: timing.elapsedMs, totalMs: timing.totalMs }
  });

  const boosted = result.deltas.filter((d) => d.delta > 0);
  const perItemDeltas = boosted
    .map((d) => ({ newsId: toObjectId(d.itemId), delta: d.delta }))
    .filter((d) => d.newsId);

  // ---- (3) LEDGER-FIRST — exactly-once guard ------------------------------
  // === transaction seam: wrap (3)-(5) in a session if a replica set exists ===
  try {
    await ViewCycleLog.create({
      campaignId: campaign._id,
      cycleIndex,
      dryRun: !!campaign.dryRun,
      itemsAffected: result.itemsAffected,
      totalIncrement: result.totalIncrement,
      perItemDeltas,
      decisionSnapshot: {
        boostedCount: boosted.length,
        itemsAffected: result.itemsAffected,
        totalIncrement: result.totalIncrement
      },
      workerId: WORKER_ID
    });
  } catch (err) {
    if (err && err.code === 11000) {
      // Cycle already processed by another worker/attempt — idempotent no-op.
      return { status: 'duplicate', cycleIndex };
    }
    throw err; // real error => worker leaves job pending for retry
  }

  // ---- (4) APPLY synthetic views (skip entirely in dryRun) ----------------
  if (!campaign.dryRun && boosted.length) {
    const newsOps = [];
    for (const d of boosted) {
      const oid = toObjectId(d.itemId);
      if (!oid) continue;
      // $inc syntheticViews ONLY — organic `views` is never touched.
      newsOps.push({ 
        updateOne: { 
          filter: { _id: oid }, 
          update: { 
            $inc: { syntheticViews: d.delta },
            $set: { viewEngineCampaignId: campaign._id }
          } 
        } 
      });
    }
    await bulkWriteChunked(News, newsOps);
  }

  // ---- (5) STATE UPDATE (delivered + cooldown + cursor) -------------------
  const stateOps = [];
  for (const d of result.deltas) {
    const oid = toObjectId(d.itemId);
    if (!oid) continue;
    stateOps.push({
      updateOne: {
        filter: { campaignId: campaign._id, newsId: oid },
        update: {
          $set: {
            deliveredTotal: d.newDeliveredTotal,
            cooldownUntilCycle: d.cooldownUntilCycle,
            lastCycleIndex: cycleIndex
          }
        }
      }
    });
  }
  await bulkWriteChunked(ViewDistributionState, stateOps);

  return {
    status: campaign.dryRun ? 'dry_run' : 'applied',
    cycleIndex,
    itemsAffected: result.itemsAffected,
    totalIncrement: result.totalIncrement
  };
}

/**
 * The worker handler. Processes one {campaignId, cycleIndex} job.
 * Throws on unexpected errors (worker leaves the job pending -> retry/DLQ).
 */
async function processCycle(job) {
  if (!job || !job.campaignId || !Number.isFinite(job.cycleIndex)) {
    return { status: 'invalid_job' };
  }
  const campaign = await ViewCampaign.findById(job.campaignId);
  if (!campaign) return { status: 'no_campaign' };
  if (campaign.status !== 'active') return { status: 'inactive' };

  const now = Date.now();
  if (campaign.endAt && now > new Date(campaign.endAt).getTime()) {
    // Past the window — lifecycle (ticker) will mark it completed; nothing to apply.
    return { status: 'ended' };
  }

  const cycleIndex = job.cycleIndex;
  const timing = computeTiming(campaign, now);

  try {
    const stateCount = await ViewDistributionState.countDocuments({ campaignId: campaign._id });
    if (shouldRebalance(campaign, cycleIndex, stateCount)) {
      const n = await rebalance(campaign, cycleIndex, new Date(now));
      console.log(`${LOG_PREFIX} applier: rebalanced ${n} item(s) for campaign ${campaign._id} @cycle ${cycleIndex}`);
    }
    const res = await applyCycle(campaign, cycleIndex, timing);
    if (res.status === 'applied' || res.status === 'dry_run') {
      console.log(
        `${LOG_PREFIX} applier: ${res.status} campaign ${campaign._id} cycle ${cycleIndex} — +${res.totalIncrement} across ${res.itemsAffected} item(s)`
      );
    }
    return res;
  } catch (err) {
    console.error(`${LOG_PREFIX} applier error (campaign ${job.campaignId} cycle ${cycleIndex}):`, err.message);
    throw err;
  }
}

module.exports = {
  processCycle,
  // exported for tests / reuse
  computeTiming,
  shouldRebalance,
  rebalanceCyclesOf,
  bulkWriteChunked
};
