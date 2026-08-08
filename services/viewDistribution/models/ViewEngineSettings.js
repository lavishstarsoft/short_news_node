const mongoose = require('mongoose');

/**
 * ViewEngineSettings — single-document persisted configuration for the View
 * Engine admin Settings page. Isolated from the engine algorithms.
 *
 * NOTE on "live" vs "stored only":
 *  - Engine ON/OFF is NOT stored here — it lives in AppSettings.viewEngineEnabled
 *    (the value the engine actually reads). The Settings page toggles that.
 *  - Every field below (including globalDryRun) is persisted config that is NOT
 *    read by the engine (Worker/Allocator/Ticker/Strategy/Applier/campaign
 *    creation are unchanged). The UI labels them "Stored Only (Not Yet Wired)".
 *    They are real saved values, not mock data. Each campaign uses only its own
 *    saved configuration; changing these settings never affects existing or new
 *    campaigns until a future wiring explicitly consumes them.
 */
const viewEngineSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'view_engine_settings' },

    // Dry Run (LIVE — default for new campaigns)
    globalDryRun: { type: Boolean, default: false },

    // Distribution defaults (Stored Only)
    defaultStrategy: { type: String, enum: ['static', 'adaptive', 'ml'], default: 'adaptive' },
    defaultDurationMinutes: { type: Number, default: 60 },
    defaultMinViews: { type: Number, default: 1000, min: 0 },
    defaultMaxViews: { type: Number, default: 2000, min: 0 },
    rebalanceIntervalSec: { type: Number, default: 300, min: 30, max: 3600 },
    maxItemSharePct: { type: Number, default: 15, min: 1, max: 100 },
    cooldownCycles: { type: Number, default: 2, min: 0, max: 100 },

    // Queue settings (Stored Only)
    workerCount: { type: Number, default: 1, min: 1, max: 64 },
    batchSize: { type: Number, default: 10, min: 1, max: 1000 },
    pollIntervalMs: { type: Number, default: 1000, min: 100, max: 60000 },
    retryAttempts: { type: Number, default: 5, min: 0, max: 20 },

    // Safety settings (Stored Only)
    autoRollback: { type: Boolean, default: false },
    allowRestart: { type: Boolean, default: true },
    allowDuplicateCampaign: { type: Boolean, default: false },
    enableGeoTargeting: { type: Boolean, default: false },
    enableLiveSync: { type: Boolean, default: false }
  },
  { timestamps: true, autoIndex: false }
);

module.exports = mongoose.model('ViewEngineSettings', viewEngineSettingsSchema);
