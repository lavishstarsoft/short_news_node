'use strict';

/**
 * Phase-0 Same-Event SHADOW metric (ADDITIVE, isolated collection).
 *
 * One document per shadow evaluation. This collection is written ONLY when
 * DUP_SAMEEVENT_SHADOW_ENABLED is true. It NEVER affects News / duplicate /
 * rejection / publication behaviour — it exists purely to measure the proposed
 * detector against human approve/reject ground truth (joined at analysis time
 * via `newsId`). No article bodies are stored.
 */

const mongoose = require('mongoose');

const signalSchema = new mongoose.Schema(
  {
    semantic: { type: Number, default: null },
    factOverlap: { type: Number, default: null },
    geoMatch: { type: Number, default: null },
    dateProximity: { type: Number, default: null },
    entityOverlap: { type: Number, default: null },
    textCosine: { type: Number, default: null },
    numberOverlap: { type: Number, default: null },
  },
  { _id: false }
);

const refMatchSchema = new mongoose.Schema(
  {
    newsId: { type: String, required: true },
    referenceOnly: { type: Boolean, default: false }, // true = matched a REJECTED article
    source: { type: String, default: null }, // vector | event | both
    sameAuthor: { type: Boolean, default: false },
    verdict: { type: String, default: 'different' },
    verdictGuarded: { type: String, default: 'different' },
    confidence: { type: Number, default: 0 },
    similarity: { type: signalSchema, default: () => ({}) },
    reason: { type: String, default: null },
  },
  { _id: false }
);

const duplicateShadowMetricSchema = new mongoose.Schema(
  {
    newsId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', required: true, index: true },
    version: { type: String, required: true },
    language: { type: String, index: true },
    authorId: { type: String, default: null, index: true },
    location: { type: String, default: null },
    newsPublishedAt: { type: Date, default: null },

    // Shadow decision (NOT production). Two variants for calibration.
    verdict: { type: String, default: 'different', index: true }, // reused calibrated bands
    verdictGuarded: { type: String, default: 'different', index: true }, // + geo/date guard
    confidence: { type: Number, default: 0 },
    topSignals: { type: signalSchema, default: () => ({}) },

    // Production decision snapshot at evaluation time (for immediate diffing).
    productionVerdict: { type: String, default: 'different', index: true },
    differsFromProduction: { type: Boolean, default: false, index: true },

    // Candidate observability.
    candidateStats: { type: mongoose.Schema.Types.Mixed, default: {} },
    queryEmbeddingAvailable: { type: Boolean, default: false },

    referenceMatches: { type: [refMatchSchema], default: [] },

    generatedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

// Latest-per-news lookups + calibration scans.
duplicateShadowMetricSchema.index({ newsId: 1, generatedAt: -1 });
duplicateShadowMetricSchema.index({ language: 1, verdictGuarded: 1, generatedAt: -1 });

module.exports =
  mongoose.models.DuplicateShadowMetric ||
  mongoose.model('DuplicateShadowMetric', duplicateShadowMetricSchema);
