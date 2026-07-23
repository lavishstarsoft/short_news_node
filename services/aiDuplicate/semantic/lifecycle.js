'use strict';

/**
 * Semantic embedding lifecycle helpers — Phase-3B.1 (planning only).
 *
 * Documented flow:
 *   contentHash change → mark STALE → enqueue future embed job (PENDING)
 *
 * These functions return PLANS. They do not write MongoDB or enqueue Redis.
 */

const { STATUS } = require('./statuses');
const { buildPendingNewsVectorDraft } = require('./newsVectorContract');
const { buildEmbedTextJobPayload } = require('./embedJobContract');
const C = require('./constants');

/**
 * Decide what should happen when article text hash changes.
 *
 * @param {object} input
 * @param {string} input.newsId
 * @param {string} input.previousContentHash
 * @param {string} input.nextContentHash
 * @param {string} [input.language]
 * @param {string} [input.title]
 * @param {string} [input.content]
 * @param {object|null} [input.existingVector] current news_vectors doc if any
 * @returns {object} lifecycle plan (not executed)
 */
function planContentHashChange(input = {}) {
  const previous = input.previousContentHash || null;
  const next = input.nextContentHash || null;
  const unchanged = previous && next && previous === next;

  if (!next) {
    return {
      changed: false,
      actions: [],
      error: 'nextContentHash required',
    };
  }

  if (unchanged) {
    return {
      changed: false,
      actions: [],
      message: 'contentHash unchanged — no STALE / re-embed',
    };
  }

  const actions = [];

  if (input.existingVector && input.existingVector.status === STATUS.READY) {
    actions.push({
      type: 'mark_vector_stale',
      newsId: String(input.newsId),
      fromStatus: STATUS.READY,
      toStatus: STATUS.STALE,
      previousContentHash: previous,
      nextContentHash: next,
    });
  } else if (input.existingVector && input.existingVector.status === STATUS.PENDING) {
    actions.push({
      type: 'supersede_pending_vector',
      newsId: String(input.newsId),
      toStatus: STATUS.STALE,
      note: 'Previous PENDING becomes STALE; new PENDING draft follows',
    });
  }

  const pendingDraft = buildPendingNewsVectorDraft({
    newsId: input.newsId,
    contentHash: next,
    language: input.language,
    isActive: input.isActive,
    publishedAt: input.publishedAt,
  });

  actions.push({
    type: 'upsert_vector_pending',
    draft: pendingDraft,
  });

  const job = buildEmbedTextJobPayload({
    newsId: input.newsId,
    language: input.language,
    title: input.title,
    content: input.content,
    contentHash: next,
    reason: 'content_hash_changed',
    source: 'lifecycle_plan',
  });

  actions.push({
    type: 'enqueue_embed_job',
    job,
    note: 'Phase-3B.1: job is planned only; queue port will not execute',
  });

  return {
    changed: true,
    previousContentHash: previous,
    nextContentHash: next,
    embeddingVersion: C.DEFAULT_EMBEDDING_VERSION,
    modelId: C.DEFAULT_MODEL_ID,
    actions,
  };
}

module.exports = {
  planContentHashChange,
};
