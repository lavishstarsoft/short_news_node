'use strict';

/**
 * NewsVector persistence service — Phase-3B.3.
 *
 * Node is the ONLY writer. Not wired to controllers/gateway/queue workers.
 * Callers (future phases) inject or require this service explicitly.
 */

const mongoose = require('mongoose');
const C = require('./constants');
const { STATUS } = require('./statuses');
const { validateEmbedResponse } = require('./embedResponseValidator');
const { planContentHashChange } = require('./lifecycle');
const { buildEmbedTextJobPayload } = require('./embedJobContract');
const { CLEAR_CLAIM } = require('./embedWorkerClaim');

function createNewsVectorPersistence(deps = {}) {
  const getModel = () => deps.NewsVector || require('../../../models/NewsVector');

  function toObjectId(newsId) {
    if (newsId instanceof mongoose.Types.ObjectId) return newsId;
    return new mongoose.Types.ObjectId(String(newsId));
  }

  /**
   * Ensure a PENDING row exists for newsId + embeddingVersion.
   */
  async function ensurePending(input = {}) {
    const NewsVector = getModel();
    const newsId = toObjectId(input.newsId);
    const contentHash = String(input.contentHash || '');
    const language = (input.language || 'te').toLowerCase();
    const embeddingVersion = input.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION;
    const modelId = input.modelId || C.DEFAULT_MODEL_ID;

    if (!contentHash) {
      throw new Error('ensurePending requires contentHash');
    }

    const doc = await NewsVector.findOneAndUpdate(
      {
        newsId,
        embeddingVersion,
        modality: C.MODALITY_TEXT,
      },
      {
        $set: {
          language,
          isActive: input.isActive === true,
          publishedAt: input.publishedAt || null,
          contentHash,
          modelId,
          dimensions: C.EMBEDDING_DIMENSIONS,
          status: STATUS.PENDING,
          lastError: null,
          embedding: undefined,
          embedAttempts: 0,
          nextEmbedAt: null,
          lastEmbedAttemptAt: null,
          ...CLEAR_CLAIM,
        },
        $setOnInsert: {
          modality: C.MODALITY_TEXT,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return doc;
  }

  /**
   * Validate /v1/embed response and transition PENDING → READY.
   * Rejects wrong model/version/dimensions/schema — no write on failure.
   */
  async function persistEmbedSuccess(input = {}) {
    const validation = validateEmbedResponse(input.embedResponse, {
      modelId: input.expectedModelId,
      embeddingVersion: input.expectedEmbeddingVersion,
      dimensions: input.expectedDimensions,
    });

    if (!validation.ok) {
      return {
        persisted: false,
        status: null,
        error: validation.error,
      };
    }

    const NewsVector = getModel();
    const newsId = toObjectId(input.newsId);
    const contentHash = String(input.contentHash || '');
    if (!contentHash) {
      return { persisted: false, status: null, error: 'contentHash required' };
    }

    const embeddingVersion = validation.value.embeddingVersion;
    const doc = await NewsVector.findOneAndUpdate(
      {
        newsId,
        embeddingVersion,
        modality: C.MODALITY_TEXT,
      },
      {
        $set: {
          language: (input.language || 'te').toLowerCase(),
          isActive: input.isActive === true,
          publishedAt: input.publishedAt || null,
          contentHash,
          modelId: validation.value.modelId,
          dimensions: validation.value.dimensions,
          embedding: validation.value.embedding,
          status: STATUS.READY,
          lastError: null,
          embedAttempts: 0,
          nextEmbedAt: null,
          ...CLEAR_CLAIM,
        },
        $setOnInsert: {
          modality: C.MODALITY_TEXT,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return {
      persisted: true,
      status: STATUS.READY,
      doc,
    };
  }

  /**
   * Mark vector FAILED (e.g. after AI embed error). Does not store embedding.
   */
  async function persistEmbedFailure(input = {}) {
    const NewsVector = getModel();
    const newsId = toObjectId(input.newsId);
    const contentHash = String(input.contentHash || '');
    const embeddingVersion = input.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION;
    const lastError = String(input.error || 'embed failed').slice(0, 2000);

    const doc = await NewsVector.findOneAndUpdate(
      {
        newsId,
        embeddingVersion,
        modality: C.MODALITY_TEXT,
      },
      {
        $set: {
          language: (input.language || 'te').toLowerCase(),
          contentHash: contentHash || undefined,
          modelId: input.modelId || C.DEFAULT_MODEL_ID,
          dimensions: C.EMBEDDING_DIMENSIONS,
          status: STATUS.FAILED,
          lastError,
          embedding: undefined,
          ...CLEAR_CLAIM,
        },
        $setOnInsert: {
          modality: C.MODALITY_TEXT,
          contentHash: contentHash || 'unknown',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return {
      persisted: true,
      status: STATUS.FAILED,
      doc,
    };
  }

  /**
   * Mark existing vector STALE when contentHash changed.
   * Does not clear embedding (kept for audit until PENDING overwrite).
   * Does not enqueue jobs.
   */
  async function markStale(input = {}) {
    const NewsVector = getModel();
    const newsId = toObjectId(input.newsId);
    const embeddingVersion = input.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION;

    const doc = await NewsVector.findOneAndUpdate(
      {
        newsId,
        embeddingVersion,
        modality: C.MODALITY_TEXT,
        status: { $in: [STATUS.READY, STATUS.PENDING, STATUS.FAILED] },
      },
      {
        $set: {
          status: STATUS.STALE,
          lastError: null,
        },
      },
      { new: true }
    );

    return {
      updated: Boolean(doc),
      status: doc ? STATUS.STALE : null,
      doc,
    };
  }

  /**
   * contentHash change → mark STALE, then move to PENDING with new hash.
   * Builds a future embed job payload but does NOT enqueue (no Redis worker).
   *
   * Note: unique key is (newsId, embeddingVersion, modality), so the same
   * document transitions STALE → PENDING (STALE is applied first).
   */
  async function markStaleAndPrepareReembed(input = {}) {
    const NewsVector = getModel();
    const newsId = toObjectId(input.newsId);
    const previousContentHash = input.previousContentHash || null;
    const nextContentHash = String(input.nextContentHash || '');
    const embeddingVersion = input.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION;

    if (!nextContentHash) {
      return { changed: false, error: 'nextContentHash required' };
    }

    const found = NewsVector.findOne({
      newsId,
      embeddingVersion,
      modality: C.MODALITY_TEXT,
    });
    const existing =
      found && typeof found.lean === 'function' ? await found.lean() : await found;

    const plan = planContentHashChange({
      newsId: String(input.newsId),
      previousContentHash,
      nextContentHash,
      language: input.language,
      title: input.title,
      content: input.content,
      isActive: input.isActive,
      publishedAt: input.publishedAt,
      existingVector: existing,
    });

    if (!plan.changed) {
      return {
        changed: false,
        plan,
        preparedJob: null,
        staleResult: null,
        pendingDoc: null,
      };
    }

    const staleResult = await markStale({
      newsId: input.newsId,
      embeddingVersion,
    });

    const pendingDoc = await ensurePending({
      newsId: input.newsId,
      contentHash: nextContentHash,
      language: input.language,
      isActive: input.isActive,
      publishedAt: input.publishedAt,
      embeddingVersion,
    });

    const preparedJob = buildEmbedTextJobPayload({
      newsId: String(input.newsId),
      language: input.language,
      title: input.title,
      content: input.content,
      contentHash: nextContentHash,
      reason: 'content_hash_changed',
      source: 'persistence_3b3',
    });

    return {
      changed: true,
      plan,
      staleResult,
      pendingDoc,
      preparedJob,
      enqueued: false,
      note: 'Phase-3B.3: job prepared only; no queue execution',
    };
  }

  return {
    ensurePending,
    persistEmbedSuccess,
    persistEmbedFailure,
    markStale,
    markStaleAndPrepareReembed,
    validateEmbedResponse,
    STATUS,
  };
}

const defaultPersistence = createNewsVectorPersistence();

module.exports = {
  createNewsVectorPersistence,
  ensurePending: defaultPersistence.ensurePending,
  persistEmbedSuccess: defaultPersistence.persistEmbedSuccess,
  persistEmbedFailure: defaultPersistence.persistEmbedFailure,
  markStale: defaultPersistence.markStale,
  markStaleAndPrepareReembed: defaultPersistence.markStaleAndPrepareReembed,
  validateEmbedResponse,
};
