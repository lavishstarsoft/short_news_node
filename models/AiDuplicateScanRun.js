'use strict';

const mongoose = require('mongoose');

const aiDuplicateScanRunSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['running', 'completed', 'failed', 'skipped'],
      default: 'running',
      index: true,
    },
    trigger: {
      type: String,
      enum: ['schedule', 'manual', 'startup'],
      default: 'schedule',
    },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    languagesProcessed: { type: [String], default: [] },
    liveNewsCount: { type: Number, default: 0 },
    readyVectorCount: { type: Number, default: 0 },
    articlesScanned: { type: Number, default: 0 },
    edgesFound: { type: Number, default: 0 },
    groupsCreated: { type: Number, default: 0 },
    groupsReplaced: { type: Number, default: 0 },
    method: {
      type: String,
      enum: ['atlas', 'windowed_cosine', 'mixed', 'none'],
      default: 'none',
    },
    error: { type: String, default: null },
    coveragePercent: { type: Number, default: 0 },
    minSimilarity: { type: Number, default: 0.88 },
    compareWindowHours: { type: Number, default: 72 },
    triggeredBy: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: 'ai_duplicate_scan_runs',
  }
);

aiDuplicateScanRunSchema.index({ createdAt: -1 });

module.exports =
  mongoose.models.AiDuplicateScanRun ||
  mongoose.model('AiDuplicateScanRun', aiDuplicateScanRunSchema);
