'use strict';

/**
 * AI Insights — Duplicate Groups collection.
 * Node is the only writer. Advisory labels only — never a verdict.
 */

const mongoose = require('mongoose');
const C = require('../services/aiInsights/constants');

const memberSchema = new mongoose.Schema(
  {
    newsId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', required: true },
    role: {
      type: String,
      enum: Object.values(C.MEMBER_ROLE),
      required: true,
    },
    headline: { type: String, default: '' },
    reporterName: { type: String, default: null },
    reporterId: { type: String, default: null },
    subEditorName: { type: String, default: null },
    subEditorId: { type: String, default: null },
    publishedAt: { type: Date, required: true },
    language: { type: String, default: 'te' },
    similarityToOriginal: { type: Number, default: 1 },
    similarityPercent: { type: Number, default: 100 },
    timeDiffMsFromOriginal: { type: Number, default: 0 },
    timeDiffLabel: { type: String, default: '+00:00:00' },
  },
  { _id: false }
);

const aiDuplicateGroupSchema = new mongoose.Schema(
  {
    groupNumber: { type: Number, required: true, index: true },
    language: { type: String, required: true, index: true, lowercase: true },
    status: {
      type: String,
      enum: Object.values(C.GROUP_STATUS),
      default: C.GROUP_STATUS.OPEN,
      index: true,
    },
    originalNewsId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'News',
      required: true,
      index: true,
    },
    members: { type: [memberSchema], default: [] },
    similarCount: { type: Number, default: 0 },
    highestSimilarity: { type: Number, default: 0 },
    highestSimilarityPercent: { type: Number, default: 0 },
    averageSimilarity: { type: Number, default: 0 },
    averageSimilarityPercent: { type: Number, default: 0 },
    firstPublishedAt: { type: Date, required: true, index: true },
    lastPublishedAt: { type: Date, required: true },
    spanMs: { type: Number, default: 0 },
    scanRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'AiDuplicateScanRun', default: null },
    embeddingVersion: { type: String, default: 'e5s-v1' },
    advisoryNote: {
      type: String,
      default: C.ADVISORY_DISCLAIMER,
    },
    memberNewsIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'News' }],
      default: [],
      index: true,
    },
  },
  {
    timestamps: true,
    collection: 'ai_duplicate_groups',
  }
);

aiDuplicateGroupSchema.index({ status: 1, highestSimilarity: -1, updatedAt: -1 });
aiDuplicateGroupSchema.index({ status: 1, firstPublishedAt: -1 });
aiDuplicateGroupSchema.index({ 'members.reporterId': 1, status: 1 });
aiDuplicateGroupSchema.index({ 'members.subEditorId': 1, status: 1 });

module.exports =
  mongoose.models.AiDuplicateGroup ||
  mongoose.model('AiDuplicateGroup', aiDuplicateGroupSchema);
