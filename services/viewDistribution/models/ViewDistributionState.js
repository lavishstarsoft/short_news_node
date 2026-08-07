const mongoose = require('mongoose');

/**
 * ViewDistributionState — live per-item state for an active campaign.
 *
 * Replaces the earlier "static plan" (Refinement #2): this document is the
 * continuously updated working memory of the adaptive control loop. One row per
 * eligible news item per campaign. Bounded by ViewCampaign.itemCap.
 *
 * Carries the feature snapshot + budget/cooldown/diversity book-keeping so the
 * Phase-3 allocator can enforce all three safeguards, and so a future ML strategy
 * has ready training inputs (Refinement #4). Zero-touch: it only READS pristine
 * News signals; it never mutates existing collections.
 */
const viewDistributionStateSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ViewCampaign',
      required: true,
      index: true
    },
    newsId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'News',
      required: true
    },

    // ---- Diversity buckets (Safeguard #3) — denormalized from News at snapshot ----
    bucket: {
      category: { type: String, default: '' },
      region: { type: String, default: '' },   // location/scope key
      publisher: { type: String, default: '' } // authorId
    },

    // ---- Adaptive scoring / allocation ----
    score: { type: Number, default: 0 },        // latest weighted score
    targetShare: { type: Number, default: 0 },  // latest share of remaining budget (0..1)

    // ---- Budget protection (Safeguard #1) ----
    floor: { type: Number, default: 0 },        // min synthetic views over the campaign
    cap: { type: Number, default: 0 },          // hard max synthetic views for THIS item
    deliveredTotal: { type: Number, default: 0 }, // synthetic actually applied so far

    // ---- Organic separation (never contaminated) ----
    organicBaseline: { type: Number, default: 0 }, // News.views at last snapshot
    organicVelocity: { type: Number, default: 0 }, // Δ organic views / interval

    // ---- Cooldown book-keeping (Safeguard #2) ----
    lastBoostedCycle: { type: Number, default: -1 },
    cooldownUntilCycle: { type: Number, default: 0 },

    // ---- ML-ready snapshot (Refinement #4) ----
    featureSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },

    // ---- Loop cursors ----
    lastCycleIndex: { type: Number, default: -1 },
    lastRebalanceAt: { type: Date, default: null }
  },
  // autoIndex:false — indexes provisioned explicitly by migrate.js (OFF-first).
  { timestamps: true, autoIndex: false }
);

// One state row per (campaign, news) — also the upsert key.
viewDistributionStateSchema.index({ campaignId: 1, newsId: 1 }, { unique: true });
// Cooldown + eligibility scans within a campaign.
viewDistributionStateSchema.index({ campaignId: 1, cooldownUntilCycle: 1 });

module.exports = mongoose.model('ViewDistributionState', viewDistributionStateSchema);
