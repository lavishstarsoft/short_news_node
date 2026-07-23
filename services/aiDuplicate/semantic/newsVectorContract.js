'use strict';

/**
 * news_vectors document contract — Phase-3B.1.
 * Node owns all writes. AI never touches MongoDB.
 *
 * This module validates / builds plain objects only.
 * Persistence happens in Phase-3B.3.
 */

const C = require('./constants');
const { assertNewsVectorStatus, STATUS } = require('./statuses');

/**
 * @typedef {object} NewsVectorRecord
 * @property {string} newsId
 * @property {string} language
 * @property {boolean} [isActive]
 * @property {Date|string|null} [publishedAt]
 * @property {string} modality
 * @property {number[]|null} [embedding]
 * @property {string} embeddingVersion
 * @property {string} modelId
 * @property {string} contentHash
 * @property {'PENDING'|'READY'|'FAILED'|'STALE'} status
 * @property {string|null} [lastError]
 * @property {Date|string|null} [updatedAt]
 * @property {Date|string|null} [createdAt]
 */

function buildPendingNewsVectorDraft(input = {}) {
  const newsId = input.newsId != null ? String(input.newsId) : '';
  const contentHash = input.contentHash != null ? String(input.contentHash) : '';
  const language = (input.language || 'te').toLowerCase();

  if (!newsId) throw new Error('newsId is required');
  if (!contentHash) throw new Error('contentHash is required');

  return {
    newsId,
    language,
    isActive: input.isActive === true,
    publishedAt: input.publishedAt || null,
    modality: C.MODALITY_TEXT,
    embedding: null,
    embeddingVersion: input.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION,
    modelId: input.modelId || C.DEFAULT_MODEL_ID,
    contentHash,
    status: STATUS.PENDING,
    lastError: null,
    dimensions: C.EMBEDDING_DIMENSIONS,
  };
}

/**
 * Validate a news_vectors-shaped object (no DB).
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
function validateNewsVectorRecord(doc) {
  if (!doc || typeof doc !== 'object') {
    return { ok: false, error: 'record must be an object' };
  }
  if (!doc.newsId) return { ok: false, error: 'newsId required' };
  if (!doc.contentHash) return { ok: false, error: 'contentHash required' };
  if (!doc.embeddingVersion) return { ok: false, error: 'embeddingVersion required' };
  if (!doc.modelId) return { ok: false, error: 'modelId required' };
  try {
    assertNewsVectorStatus(doc.status);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (doc.status === STATUS.READY) {
    if (!Array.isArray(doc.embedding) || doc.embedding.length !== C.EMBEDDING_DIMENSIONS) {
      return {
        ok: false,
        error: `READY requires embedding length ${C.EMBEDDING_DIMENSIONS}`,
      };
    }
  }
  return { ok: true, value: doc };
}

module.exports = {
  buildPendingNewsVectorDraft,
  validateNewsVectorRecord,
};
