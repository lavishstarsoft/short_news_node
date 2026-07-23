'use strict';

/**
 * Embed job CONTRACT only — Phase-3B.1.
 *
 * No Redis enqueue. No worker. No consumer.
 * Future Phase-3B.2/3B.3 will execute these payloads.
 */

const C = require('./constants');

/**
 * @typedef {object} EmbedTextJobPayload
 * @property {string} jobType
 * @property {string} newsId
 * @property {string} language
 * @property {string} title
 * @property {string} content
 * @property {string} contentHash
 * @property {string} embeddingVersion
 * @property {string} modelId
 * @property {number} dimensions
 * @property {string} createdAt
 * @property {object} meta
 */

/**
 * Build a future embed job payload (not executed).
 * Intentionally includes title/content for the future AI compute call;
 * Node will pass this to AI; AI still has no Mongo access.
 */
function buildEmbedTextJobPayload(input = {}) {
  const newsId = input.newsId != null ? String(input.newsId) : '';
  const contentHash = input.contentHash != null ? String(input.contentHash) : '';
  if (!newsId) throw new Error('embed job requires newsId');
  if (!contentHash) throw new Error('embed job requires contentHash');

  return {
    jobType: C.JOB_TYPE_EMBED_TEXT,
    newsId,
    language: (input.language || 'te').toLowerCase(),
    title: input.title || '',
    content: input.content || '',
    contentHash,
    embeddingVersion: input.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION,
    modelId: input.modelId || C.DEFAULT_MODEL_ID,
    dimensions: C.EMBEDDING_DIMENSIONS,
    createdAt: new Date().toISOString(),
    meta: {
      source: input.source || 'contract',
      reason: input.reason || 'unspecified',
      /** Executor must NOT exist in 3B.1 */
      executable: false,
      phase: '3B.1',
    },
  };
}

/**
 * Queue port (interface).
 * Phase-4.1: background poller is embedPendingWorker (AI_EMBED_WORKER_ENABLED).
 * This port remains a non-Redis stub for contract callers.
 */
function createEmbedJobQueuePort() {
  return {
    /**
     * @param {EmbedTextJobPayload} _payload
     * @returns {Promise<{ accepted: false, reason: string }>}
     */
    async enqueue(_payload) {
      return {
        accepted: false,
        reason:
          'Use news_vectors status=PENDING + embedPendingWorker (AI_EMBED_WORKER_ENABLED). Redis queue not required in Phase-4.1.',
      };
    },
  };
}

module.exports = {
  buildEmbedTextJobPayload,
  createEmbedJobQueuePort,
};
