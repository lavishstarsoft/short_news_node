'use strict';

/**
 * Phase-3B.1 — Mongoose model for future news_vectors persistence.
 *
 * Node is the ONLY writer (Phase-3B.3+).
 * AI Service must never import or use this model.
 *
 * Not wired into create/update/detect paths in 3B.1.
 */

const mongoose = require('mongoose');
const {
  STATUS,
  DEFAULT_MODEL_ID,
  DEFAULT_EMBEDDING_VERSION,
  EMBEDDING_DIMENSIONS,
  MODALITY_TEXT,
} = require('../services/aiDuplicate/semantic/constants');

const ALLOWED_STATUS = Object.values(STATUS);

const newsVectorSchema = new mongoose.Schema(
  {
    newsId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'News',
      required: true,
      index: true,
    },
    language: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: false,
      index: true,
    },
    publishedAt: {
      type: Date,
      default: null,
      index: true,
    },
    modality: {
      type: String,
      default: MODALITY_TEXT,
      enum: [MODALITY_TEXT],
    },
    /** Populated in Phase-3B.3 when status becomes READY */
    embedding: {
      type: [Number],
      default: undefined,
    },
    embeddingVersion: {
      type: String,
      required: true,
      default: DEFAULT_EMBEDDING_VERSION,
      index: true,
    },
    modelId: {
      type: String,
      required: true,
      default: DEFAULT_MODEL_ID,
    },
    /** Node MD5 contentHash — change ⇒ STALE + re-queue (lifecycle) */
    contentHash: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      required: true,
      enum: ALLOWED_STATUS,
      default: STATUS.PENDING,
      index: true,
    },
    lastError: {
      type: String,
      default: null,
    },
    /** Phase-4.1 — embed worker retry bookkeeping (NewsVector only). */
    embedAttempts: {
      type: Number,
      default: 0,
    },
    nextEmbedAt: {
      type: Date,
      default: null,
      index: true,
    },
    lastEmbedAttemptAt: {
      type: Date,
      default: null,
    },
    /** Phase-4.2.6 — atomic worker claim / lease (cleared on READY|FAILED|release). */
    processingAt: {
      type: Date,
      default: null,
    },
    processingBy: {
      type: String,
      default: null,
    },
    leaseExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },
    dimensions: {
      type: Number,
      default: EMBEDDING_DIMENSIONS,
    },
  },
  {
    timestamps: true,
    collection: 'news_vectors',
  }
);

// One vector row per news + embedding version + modality (future multi-version)
newsVectorSchema.index(
  { newsId: 1, embeddingVersion: 1, modality: 1 },
  { unique: true }
);

newsVectorSchema.index({ status: 1, language: 1, publishedAt: -1 });
newsVectorSchema.index({ status: 1, nextEmbedAt: 1, updatedAt: 1 });
newsVectorSchema.index({ status: 1, leaseExpiresAt: 1, nextEmbedAt: 1 });

module.exports =
  mongoose.models.NewsVector || mongoose.model('NewsVector', newsVectorSchema);
