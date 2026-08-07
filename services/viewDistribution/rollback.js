'use strict';

/**
 * rollback.js — reverse a campaign's synthetic contribution, ledger-driven.
 *
 * Reads ViewCycleLog.perItemDeltas and subtracts them back out of
 * News.syntheticViews. It NEVER touches organic `views`.
 *
 * Idempotency / retry-safety (no MongoDB transactions available):
 *   Each cycle is CLAIMED atomically via findOneAndUpdate({reversedAt:null} -> now)
 *   before its deltas are applied. So:
 *     - a cycle can be reversed AT MOST ONCE  => no double-subtraction (idempotent);
 *     - two reversers (PM2) claim different cycles => PM2-safe;
 *     - re-running after completion finds no unclaimed cycles => safe no-op.
 *   On an apply error the claim is released (reversedAt -> null) so a retry
 *   reprocesses it. The only lossy window is a hard crash BETWEEN claim and apply,
 *   which leaves residual synthetic (fail-safe: never over-subtracts). With a
 *   replica set, claim+apply could be wrapped in a transaction to close it.
 *
 * Clamp-at-zero: the $inc is expressed as a pipeline update using
 *   syntheticViews = max(0, syntheticViews - delta)
 * so syntheticViews can never go negative even if campaigns overlapped.
 */

const News = require('../../models/News');
const ViewCampaign = require('./models/ViewCampaign');
const ViewCycleLog = require('./models/ViewCycleLog');
const ViewDistributionState = require('./models/ViewDistributionState');
const { bulkWriteChunked } = require('./applier'); // reuse — no duplicate logic
const { LOG_PREFIX } = require('./constants');

/**
 * Reverse all applied (non-dryRun) cycles of a campaign.
 * @returns {Promise<{ok:boolean, error?:string, cyclesReversed?:number, totalReversed?:number, status?:string}>}
 */
async function reverseCampaign(campaignId) {
  const campaign = await ViewCampaign.findById(campaignId);
  if (!campaign) return { ok: false, error: 'not_found' };
  // Must not race with the applier: pause/cancel an active campaign first.
  if (campaign.status === 'active') return { ok: false, error: 'active_must_pause_first' };

  let cyclesReversed = 0;
  let totalReversed = 0;

  // Claim-then-apply, one cycle at a time (campaigns have <= durationMinutes cycles).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cycle = await ViewCycleLog.findOneAndUpdate(
      { campaignId: campaign._id, dryRun: { $ne: true }, reversedAt: null },
      { $set: { reversedAt: new Date() } },
      { new: true, sort: { cycleIndex: 1 } }
    );
    if (!cycle) break; // nothing left to reverse

    try {
      const deltas = (cycle.perItemDeltas || []).filter((d) => d && d.newsId && d.delta > 0);
      if (deltas.length) {
        const ops = deltas.map((d) => ({
          updateOne: {
            filter: { _id: d.newsId },
            // syntheticViews = max(0, syntheticViews - delta) — clamped, organic `views` untouched.
            update: [
              {
                $set: {
                  syntheticViews: {
                    $max: [0, { $subtract: [{ $ifNull: ['$syntheticViews', 0] }, d.delta] }]
                  }
                }
              }
            ]
          }
        }));
        await bulkWriteChunked(News, ops);
        totalReversed += deltas.reduce((s, d) => s + d.delta, 0);
      }
      cyclesReversed++;
    } catch (err) {
      // Release the claim so this cycle can be retried; then surface the error.
      await ViewCycleLog.updateOne({ _id: cycle._id }, { $set: { reversedAt: null } }).catch(() => {});
      console.error(`${LOG_PREFIX} rollback: cycle ${cycle._id} failed, released claim:`, err.message);
      throw err;
    }
  }

  // Best-effort: zero the live delivered counters (idempotent), then mark reversed.
  await ViewDistributionState.updateMany(
    { campaignId: campaign._id },
    { $set: { deliveredTotal: 0 } }
  ).catch(() => {});

  if (campaign.status !== 'reversed') {
    campaign.status = 'reversed';
    await campaign.save();
  }

  console.log(
    `${LOG_PREFIX} rollback: campaign ${campaign._id} reversed — ${cyclesReversed} cycle(s), -${totalReversed} synthetic`
  );
  return { ok: true, cyclesReversed, totalReversed, status: 'reversed' };
}

module.exports = { reverseCampaign };
