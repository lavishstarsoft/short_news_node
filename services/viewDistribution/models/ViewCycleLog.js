const mongoose = require('mongoose');

/**
 * ViewCycleLog — append-only ledger of every synthetic distribution cycle.
 *
 * Three jobs:
 *  1. Idempotency / no-duplicate-processing — the unique {campaignId, cycleIndex}
 *     index is the final guard: a cycle can be committed exactly once, cluster-wide.
 *  2. Rollback — perItemDeltas records exactly how much synthetic was added to each
 *     item, so reverseCampaign can $inc it back out of News.syntheticViews precisely.
 *  3. AI training / audit — decisionSnapshot captures the strategy decision + safeguard
 *     adjustments (budget/cooldown/diversity) that produced this cycle.
 *
 * Records are never updated after insert (createdAt only).
 */
const viewCycleLogSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ViewCampaign',
      required: true,
      index: true
    },
    // Minute number since campaign.startAt — deterministic, wall-clock anchored.
    cycleIndex: { type: Number, required: true },
    // Keyset batch number within a cycle (per_news_window). 0 = production/single-batch.
    batchNo: { type: Number, default: 0 },

    // dryRun cycles are logged but applied nothing to News (validation runs).
    dryRun: { type: Boolean, default: false },

    itemsAffected: { type: Number, default: 0 },
    totalIncrement: { type: Number, default: 0 },

    // The reversible ledger: exact synthetic delta applied per item this cycle.
    perItemDeltas: {
      type: [
        {
          _id: false,
          newsId: { type: mongoose.Schema.Types.ObjectId, ref: 'News' },
          delta: { type: Number }
        }
      ],
      default: []
    },

    // Strategy output + safeguard decisions for this cycle (audit + future ML).
    decisionSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },

    // Which instance committed the cycle (leader/worker id).
    workerId: { type: String, default: '' },

    // Rollback bookkeeping (the ONLY mutation allowed on a ledger row): set once
    // when this cycle's synthetic deltas have been reversed out of News.
    // Enables idempotent, retry-safe, claim-then-apply reversal (see rollback.js).
    reversedAt: { type: Date, default: null }
  },
  // autoIndex:false — indexes provisioned explicitly by migrate.js (OFF-first).
  { timestamps: { createdAt: true, updatedAt: false }, autoIndex: false }
);

// Idempotency guard — one committed cycle per (campaign, cycleIndex).
// Exactly-once per (campaign, cycle, batch). batchNo default 0 => production mode
// keeps its {campaignId,cycleIndex} guarantee. (Migration drops the old 2-field unique.)
viewCycleLogSchema.index({ campaignId: 1, cycleIndex: 1, batchNo: 1 }, { unique: true });

// Retention (TTL) — bounds storage on long-running campaigns.
// SAFE because: (a) a cycle can only be re-enqueued within the queue's 10-min dedup
// window and cycleIndex is wall-clock monotonic, so rows older than that are NEVER
// reprocessed (idempotency intact); (b) reversal (rollback) of any cycle is possible
// within this window. Beyond it, per-news totals still live in
// ViewDistributionState.deliveredTotal (which rollback now uses). Default 60 min.
// NOTE: TTL replaces the old {createdAt:-1} index and also serves createdAt sorts.
// Changing retention requires dropping this index and re-running migrate (collMod).
const LEDGER_RETENTION_MINUTES = Math.max(
  15, // must exceed the queue reprocess window (~10 min dedup + retry) for idempotency
  parseInt(process.env.VIEW_ENGINE_LEDGER_RETENTION_MINUTES, 10) || 60
);
viewCycleLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: LEDGER_RETENTION_MINUTES * 60 }
);

// Rollback scan: find unreversed cycles for a campaign.
viewCycleLogSchema.index({ campaignId: 1, reversedAt: 1 });

module.exports = mongoose.model('ViewCycleLog', viewCycleLogSchema);
