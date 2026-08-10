'use strict';

/**
 * rollback.js — reverse a campaign's synthetic contribution using the DURABLE
 * per-news counter ViewDistributionState.deliveredTotal (NOT the ledger). This
 * makes reversal independent of ViewCycleLog, so ViewCycleLog can safely
 * TTL-expire (60 min) without ever corrupting a reversal.
 *
 * Idempotent + crash-safe (no MongoDB transactions available):
 *   Each news is CLAIMED atomically by zeroing deliveredTotal (findOneAndUpdate
 *   returns the pre-image amount) BEFORE subtracting from News.syntheticViews. So:
 *     - re-run finds no deliveredTotal>0 => no double-subtraction (idempotent);
 *     - two reversers claim different news (PM2-safe);
 *     - crash BETWEEN claim and subtract => residual synthetic (fail-safe: never
 *       over-subtracts). On a subtract error the claim is restored for retry.
 *   syntheticViews is clamped at 0; organic `views` is never touched; the
 *   viewEngineCampaignId claim is released so the news can be re-used.
 */

const News = require('../../models/News');
const ViewCampaign = require('./models/ViewCampaign');
const ViewDistributionState = require('./models/ViewDistributionState');
const { LOG_PREFIX } = require('./constants');

/**
 * @returns {Promise<{ok:boolean, error?:string, cyclesReversed?:number, totalReversed?:number, status?:string}>}
 *          (field `cyclesReversed` = number of NEWS items reversed; name kept for the API/audit).
 */
async function reverseCampaign(campaignId) {
  const campaign = await ViewCampaign.findById(campaignId);
  if (!campaign) return { ok: false, error: 'not_found' };
  // Must not race with the applier: pause/cancel an active campaign first.
  if (campaign.status === 'active') return { ok: false, error: 'active_must_pause_first' };

  let cyclesReversed = 0;
  let totalReversed = 0;

  // Claim-then-subtract, one news at a time (bounded by the campaign's item set).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const claimed = await ViewDistributionState.findOneAndUpdate(
      { campaignId: campaign._id, deliveredTotal: { $gt: 0 } },
      { $set: { deliveredTotal: 0 } },
      { new: false } // pre-image => the amount to subtract
    );
    if (!claimed) break;
    const amount = Number(claimed.deliveredTotal) || 0;
    if (amount <= 0) continue;

    try {
      await News.updateOne(
        { _id: claimed.newsId },
        [
          // syntheticViews = max(0, syntheticViews - amount) — clamped; organic `views` untouched.
          { $set: { syntheticViews: { $max: [0, { $subtract: [{ $ifNull: ['$syntheticViews', 0] }, amount] }] } } },
          { $unset: ['viewEngineCampaignId'] }
        ]
      );
      totalReversed += amount;
      cyclesReversed++;
    } catch (err) {
      // Restore the claim so this news can be retried; then surface the error.
      await ViewDistributionState.updateOne(
        { _id: claimed._id },
        { $set: { deliveredTotal: amount } }
      ).catch(() => {});
      console.error(`${LOG_PREFIX} rollback: news ${claimed.newsId} failed, claim restored:`, err.message);
      throw err;
    }
  }

  if (campaign.status !== 'reversed') {
    campaign.status = 'reversed';
    await campaign.save();
  }

  console.log(
    `${LOG_PREFIX} rollback: campaign ${campaign._id} reversed — ${cyclesReversed} item(s), -${totalReversed} synthetic`
  );
  return { ok: true, cyclesReversed, totalReversed, status: 'reversed' };
}

module.exports = { reverseCampaign };
