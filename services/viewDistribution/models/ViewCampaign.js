const mongoose = require('mongoose');

/**
 * ViewCampaign — a single admin-created distribution campaign.
 *
 * Admin surface is intentionally minimal (Refinement #3): duration, min, max,
 * eligibility scope, and an intensity dial. Everything else (per-item targets,
 * curve shape, weights, rebalancing) is derived automatically by the engine.
 *
 * Isolated plug-in — this collection is owned entirely by services/viewDistribution/.
 * No existing model references it. When AppSettings.viewEngineEnabled is false the
 * engine never reads or writes these documents.
 */
const viewCampaignSchema = new mongoose.Schema(
  {
    // ---- Lifecycle ----
    name: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['draft', 'active', 'paused', 'completed', 'cancelled', 'reversed'],
      default: 'draft',
      index: true
    },
    // dryRun: engine computes + logs decisions but skips every News $inc (safe validation).
    dryRun: { type: Boolean, default: false },

    // ---- Minimal admin inputs ----
    durationMinutes: { type: Number, required: true }, // curve window (validated in service layer)
    // 'finite' (default) => auto-completes after durationMinutes, exactly as today.
    // 'unlimited' => runs 24×7 until a Super Admin pauses/cancels/deletes (ticker guard).
    // Absent on legacy docs => treated as 'finite' (backward compatible).
    durationType: { type: String, enum: ['finite', 'unlimited'], default: 'finite' },
    // Delivery mode. 'production' (default) = existing adaptive-curve engine, unchanged.
    // 'per_news_window' = each news fills a frozen random target over its OWN window
    // (intervalMinutes) with seeded random per-minute increments, then stops forever.
    mode: { type: String, enum: ['production', 'per_news_window'], default: 'production' },
    intervalMinutes: { type: Number, default: null }, // per-news growth window (per_news_window only)
    minViews: { type: Number, required: true, min: 0 },
    maxViews: { type: Number, required: true, min: 0 },

    // Coarse dial; the engine maps this to internal weights/curve aggressiveness.
    intensity: {
      type: String,
      enum: ['conservative', 'balanced', 'aggressive'],
      default: 'balanced'
    },

    // Pluggable allocation strategy (Open/Closed — future 'ml' plugs in with no schema change).
    strategy: {
      type: String,
      enum: ['static', 'adaptive', 'ml'],
      default: 'adaptive'
    },

    // ---- Eligibility snapshot filters (resolved against pristine News fields) ----
    eligibility: {
      languages: { type: [String], default: [] },
      categories: { type: [String], default: [] },
      scopes: { type: [String], default: [] },
      maxAgeHours: { type: Number, default: null } // null => no age cap
    },

    // Upper bound on how many news items a campaign may touch (keeps the working set bounded).
    itemCap: { type: Number, default: 500 },

    // How often the adaptive control loop re-scores and rebalances remaining budget.
    rebalanceIntervalSec: { type: Number, default: 300 },

    // ============================================================
    // PRODUCTION SAFEGUARDS (config only — enforcement lives in Phase-3 allocator)
    // ============================================================

    // Safeguard #1 — Global budget protection: no single item may consume a
    // disproportionate share of the total campaign synthetic budget.
    budgetProtection: {
      // Hard cap on any one item's share of the total campaign budget (percent).
      maxItemSharePct: { type: Number, default: 15 },
      // Optional absolute per-item ceiling of synthetic views (null => derive from maxViews).
      perItemMaxViews: { type: Number, default: null }
    },

    // Safeguard #2 — Cooldown: avoid boosting the same item every rebalance cycle.
    cooldown: {
      enabled: { type: Boolean, default: true },
      // Minimum number of cycles an item must rest after being boosted.
      restCycles: { type: Number, default: 2 }
    },

    // Safeguard #3 — Diversity allocation: keep visibility balanced across buckets.
    diversity: {
      enabled: { type: Boolean, default: true },
      // Dimensions used for bucketing (mapped in Phase-3: category / region / publisher).
      dimensions: { type: [String], default: ['category', 'region', 'publisher'] },
      // No single bucket may exceed this share of the campaign budget (percent).
      maxBucketSharePct: { type: Number, default: 40 }
    },

    // ---- Timing ----
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },

    // ---- Provenance (audit) ----
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null
    },
    createdByName: { type: String, default: '' }
  },
  // autoIndex:false — indexes are provisioned explicitly by migrate.js so nothing
  // is auto-created at server boot while the engine is OFF (OFF-first deployment).
  { timestamps: true, autoIndex: false }
);

// Active campaigns the ticker must service.
viewCampaignSchema.index({ status: 1, endAt: 1 });

module.exports = mongoose.model('ViewCampaign', viewCampaignSchema);
