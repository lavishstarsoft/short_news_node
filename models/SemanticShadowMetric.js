'use strict';

/**
 * Phase-3B.5 — Mongoose model for semantic shadow metrics ONLY.
 * Independent collection — never mixed into News.duplicateCheck.
 */

const mongoose = require('mongoose');
const {
  DEFAULT_MODEL_ID,
  DEFAULT_EMBEDDING_VERSION,
} = require('../services/aiDuplicate/semantic/constants');

const semanticShadowMetricSchema = new mongoose.Schema(
  {
    requestId: { type: String, default: null, index: true },
    newsId: { type: String, default: null, index: true },
    language: { type: String, required: true, lowercase: true, index: true },
    embeddingVersion: {
      type: String,
      default: DEFAULT_EMBEDDING_VERSION,
      index: true,
    },
    modelId: { type: String, default: DEFAULT_MODEL_ID },
    source: { type: String, enum: ['ai', 'legacy'], default: 'legacy' },
    status: {
      type: String,
      enum: ['ok', 'error', 'skipped'],
      default: 'ok',
      index: true,
    },
    errorCode: { type: String, default: null },

    exactScore: { type: Number, default: null },
    exactMatched: { type: Boolean, default: false },
    exactCandidateId: { type: String, default: null },

    nearScore: { type: Number, default: null },
    nearCandidateId: { type: String, default: null },
    nearMatchCount: { type: Number, default: 0 },

    semanticScore: { type: Number, default: null },
    semanticCandidateId: { type: String, default: null },
    semanticMatchCount: { type: Number, default: 0 },

    latencyMs: { type: Number, default: null },
    embedLatencyMs: { type: Number, default: null },
    vectorSearchLatencyMs: { type: Number, default: null },

    semanticAgreesWithExact: { type: Boolean, default: null },
    semanticAgreesWithNear: { type: Boolean, default: null },

    createdAt: { type: Date, default: Date.now, index: true },
  },
  {
    collection: 'semantic_shadow_metrics',
    versionKey: false,
  }
);

module.exports =
  mongoose.models.SemanticShadowMetric ||
  mongoose.model('SemanticShadowMetric', semanticShadowMetricSchema);
