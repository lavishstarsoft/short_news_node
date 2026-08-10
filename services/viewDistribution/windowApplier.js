'use strict';

/**
 * windowApplier.js — per-news window delivery mode ('per_news_window').
 *
 * Each eligible news gets ONE frozen random target in [minViews, maxViews] and
 * its OWN window (intervalMinutes) starting at its onboard time. Over that window
 * its synthetic views grow EVERY MINUTE by RANDOM positive increments that sum to
 * EXACTLY the target; at window end it lands on the target and STOPS permanently.
 *
 * Reliability (reuses the production engine's guarantees):
 *   - RANDOM increments are a SEEDED partition of the target keyed by
 *     (newsId, campaignId) — deterministic, so retries/restarts reproduce the same
 *     numbers. Delivery is TIME-ANCHORED: delta = expectedCumulative(minuteIndex)
 *     − deliveredTotal, so a missed/crashed minute self-heals and can never exceed
 *     the target.
 *   - LEDGER-FIRST: ViewCycleLog {campaignId, cycleIndex} unique => exactly-once.
 *   - FROZEN targets: onboard uses $setOnInsert only => running/completed news are
 *     never reset or recalculated when dashboard settings change.
 *   - completedAt => the news is skipped forever (never re-added).
 *   - $inc News.syntheticViews ONLY (never organic `views`); claims viewEngineCampaignId.
 *
 * Production mode (applier.js) is untouched — dispatched separately by mode.
 */

const News = require('../../models/News');
const ViewCampaign = require('./models/ViewCampaign');
const ViewDistributionState = require('./models/ViewDistributionState');
const ViewCycleLog = require('./models/ViewCycleLog');
const signalProvider = require('./signalProvider');
const { bulkWriteChunked } = require('./applier'); // reuse — no duplicate logic
const { LOG_PREFIX } = require('./constants');

const WORKER_ID = `${process.env.NODE_APP_INSTANCE ?? process.env.pm_id ?? ''}:${process.pid}`;

// Keyset batch size for delivery — bounds per-cycle memory/writes regardless of how
// many news a campaign holds. Each batch is an independently-idempotent ledger unit
// ({campaignId, cycleIndex, batchNo}). 500 keeps bulkWrite payloads small and safe.
const BATCH_SIZE = Math.max(50, parseInt(process.env.VIEW_ENGINE_WINDOW_BATCH_SIZE, 10) || 500);

// ---- deterministic seeded RNG --------------------------------------------

/** FNV-1a 32-bit hash of a string. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — deterministic, seeded. Returns a function giving [0,1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(newsId, campaignId) {
  return fnv1a(`${newsId}:${campaignId}`);
}

/** Frozen random target in [min, max], deterministic per (newsId, campaignId). */
function seededTarget(newsId, campaignId, min, max) {
  const lo = Math.max(0, Math.floor(min));
  const hi = Math.max(lo, Math.floor(max));
  if (hi === lo) return lo;
  const rng = mulberry32(seedFor(newsId, campaignId));
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * Expected cumulative delivered by `minuteIndex`, from a seeded random partition
 * of `target` across `windowMinutes` positive chunks (sum === target exactly).
 * - minuteIndex >= windowMinutes => target (window ended).
 * - target <= windowMinutes => +1 per minute for `target` minutes (completes early).
 */
function expectedCumulative(newsId, campaignId, target, windowMinutes, minuteIndex) {
  const t = Math.max(0, Math.floor(target));
  const w = Math.max(1, Math.floor(windowMinutes));
  const m = Math.max(0, Math.floor(minuteIndex));
  if (t === 0) return 0;
  if (m >= w) return t;

  // Small target: give +1 per minute until target is met, then flat.
  if (t <= w) {
    return Math.min(t, m + 1);
  }

  // target > w: base 1 per minute + random distribution of the remainder.
  const remainder = t - w;
  const rng = mulberry32(seedFor(newsId, campaignId));
  const weights = new Array(w);
  let sumW = 0;
  for (let i = 0; i < w; i++) {
    const x = rng() + 1e-9; // strictly > 0
    weights[i] = x;
    sumW += x;
  }
  // Deterministic integer distribution of `remainder` over the weights.
  let distributed = 0;
  const extra = new Array(w);
  for (let i = 0; i < w; i++) {
    extra[i] = Math.floor((remainder * weights[i]) / sumW);
    distributed += extra[i];
  }
  extra[w - 1] += remainder - distributed; // leftover => last minute (keeps sum exact)

  let cum = 0;
  for (let i = 0; i <= m && i < w; i++) {
    cum += 1 + extra[i]; // base 1 + random extra
  }
  return Math.min(cum, t);
}

// ---- onboarding: add newly eligible news (never reset existing) ----------

async function onboard(campaign, now) {
  const candidates = await signalProvider.fetchCandidates(campaign, new Date(now));
  if (!candidates.length) return 0;
  const min = Number(campaign.minViews) || 0;
  const max = Number(campaign.maxViews) || min;
  const win = Math.max(1, Number(campaign.intervalMinutes) || 1);

  const ops = candidates.map((doc) => {
    const target = seededTarget(String(doc._id), String(campaign._id), min, max);
    return {
      updateOne: {
        filter: { campaignId: campaign._id, newsId: doc._id },
        // $setOnInsert ONLY => a running or completed news is NEVER reset/recalculated.
        update: {
          $setOnInsert: {
            startedAt: new Date(now),
            windowMinutes: win,
            cap: target,
            deliveredTotal: 0,
            completedAt: null,
            lastCycleIndex: -1,
            bucket: {
              category: doc.category || '',
              region: doc.location || doc.scope || '',
              publisher: String(doc.authorId || '')
            },
            organicBaseline: doc.views || 0
          }
        },
        upsert: true
      }
    };
  });
  await bulkWriteChunked(ViewDistributionState, ops);
  return ops.length;
}

// ---- cycle handler --------------------------------------------------------

async function processCycle(job) {
  if (!job || !job.campaignId || !Number.isFinite(job.cycleIndex)) {
    return { status: 'invalid_job' };
  }
  const campaign = await ViewCampaign.findById(job.campaignId);
  if (!campaign) return { status: 'no_campaign' };
  if (campaign.status !== 'active') return { status: 'inactive' };

  const now = Date.now();
  if (campaign.endAt && now > new Date(campaign.endAt).getTime()) {
    return { status: 'ended' };
  }
  const cycleIndex = job.cycleIndex;

  try {
    // 1. Onboard newly-eligible news (frozen target + own window).
    await onboard(campaign, now);

    // 2-6. Keyset-batched delivery: never loads the whole active set into memory.
    // Bounded reads/writes per batch; `now` (captured at cycle start) is reused for
    // every batch so minuteIndex/expectedCumulative are identical across batches.
    let lastId = null;
    let totalIncrement = 0;
    let itemsAffected = 0;
    let batchNo = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const q = { campaignId: campaign._id, completedAt: null };
      if (lastId) q._id = { $gt: lastId };
      const states = await ViewDistributionState.find(q)
        .select('newsId cap deliveredTotal startedAt windowMinutes')
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .lean();
      if (!states.length) break;
      lastId = states[states.length - 1]._id;

      // Per-news deltas (time-anchored, seeded, never exceeds target).
      const deltas = [];
      for (const s of states) {
        const target = Number(s.cap) || 0;
        const win = Math.max(1, Number(s.windowMinutes) || Number(campaign.intervalMinutes) || 1);
        const startedMs = s.startedAt ? new Date(s.startedAt).getTime() : now;
        const minuteIndex = Math.max(0, Math.floor((now - startedMs) / 60000));
        const delivered = Number(s.deliveredTotal) || 0;

        const expected = expectedCumulative(String(s.newsId), String(campaign._id), target, win, minuteIndex);
        let delta = expected - delivered;
        if (delta < 0) delta = 0;

        const windowEnded = minuteIndex >= win;
        let newDelivered = delivered + delta;
        let completed = false;
        if (windowEnded || newDelivered >= target) {
          newDelivered = target;          // land EXACTLY on the frozen target
          delta = Math.max(0, target - delivered);
          completed = true;               // freeze permanently
        }
        deltas.push({ newsId: s.newsId, delta, newDelivered, completed });
      }

      const boosted = deltas.filter((d) => d.delta > 0);
      const batchIncrement = boosted.reduce((a, d) => a + d.delta, 0);

      // LEDGER-FIRST per batch — exactly-once guard {campaignId, cycleIndex, batchNo}.
      try {
        await ViewCycleLog.create({
          campaignId: campaign._id,
          cycleIndex,
          batchNo,
          dryRun: !!campaign.dryRun,
          itemsAffected: boosted.length,
          totalIncrement: batchIncrement,
          decisionSnapshot: { mode: 'per_news_window', batchNo },
          workerId: WORKER_ID
        });
      } catch (err) {
        if (err && err.code === 11000) {
          // This batch already applied (retry) — skip, advance to the next range.
          batchNo++;
          if (states.length < BATCH_SIZE) break;
          continue;
        }
        throw err;
      }

      if (!campaign.dryRun && boosted.length) {
        await bulkWriteChunked(News, boosted.map((d) => ({
          updateOne: {
            filter: { _id: d.newsId },
            update: { $inc: { syntheticViews: d.delta }, $set: { viewEngineCampaignId: campaign._id } }
          }
        })));
      }

      await bulkWriteChunked(ViewDistributionState, deltas.map((d) => ({
        updateOne: {
          filter: { campaignId: campaign._id, newsId: d.newsId },
          update: {
            $set: Object.assign(
              { deliveredTotal: d.newDelivered, lastCycleIndex: cycleIndex },
              d.completed ? { completedAt: new Date(now) } : {}
            )
          }
        }
      })));

      totalIncrement += batchIncrement;
      itemsAffected += boosted.length;
      batchNo++;
      if (states.length < BATCH_SIZE) break;
    }

    if (batchNo === 0) return { status: 'no_active', cycleIndex };
    if (itemsAffected) {
      console.log(`${LOG_PREFIX} windowApplier: campaign ${campaign._id} cycle ${cycleIndex} — +${totalIncrement} across ${itemsAffected} news in ${batchNo} batch(es)`);
    }
    return { status: campaign.dryRun ? 'dry_run' : 'applied', cycleIndex, itemsAffected, totalIncrement };
  } catch (err) {
    console.error(`${LOG_PREFIX} windowApplier error (campaign ${job.campaignId} cycle ${cycleIndex}):`, err.message);
    throw err;
  }
}

module.exports = {
  processCycle,
  // exported for tests
  seededTarget,
  expectedCumulative,
  seedFor
};
