'use strict';

/**
 * Phase-4.2.6 — Atomic claim / lease for PENDING news_vectors.
 * Phase-4.3 — reclaim vs fresh claim distinguished for metrics.
 */

const C = require('./constants');
const { STATUS } = require('./statuses');

const CLEAR_CLAIM = {
  processingAt: null,
  processingBy: null,
  leaseExpiresAt: null,
};

function buildDueNextEmbedFilter(nowDate) {
  return {
    $or: [
      { nextEmbedAt: null },
      { nextEmbedAt: { $exists: false } },
      { nextEmbedAt: { $lte: nowDate } },
    ],
  };
}

function buildDueAndClaimableFilter(nowDate) {
  return {
    status: STATUS.PENDING,
    $and: [
      buildDueNextEmbedFilter(nowDate),
      {
        $or: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $exists: false } },
          { leaseExpiresAt: { $lte: nowDate } },
        ],
      },
    ],
  };
}

function buildReclaimFilter(nowDate) {
  return {
    status: STATUS.PENDING,
    $and: [
      buildDueNextEmbedFilter(nowDate),
      { leaseExpiresAt: { $lte: nowDate } },
    ],
  };
}

function buildFreshClaimFilter(nowDate) {
  return {
    status: STATUS.PENDING,
    $and: [
      buildDueNextEmbedFilter(nowDate),
      {
        $or: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { $exists: false } },
        ],
      },
    ],
  };
}

function createEmbedWorkerClaim(deps = {}) {
  const getNewsVector = () =>
    deps.NewsVector || require('../../../models/NewsVector');
  const now = deps.now || (() => Date.now());
  const leaseMs = deps.leaseMs || C.DEFAULT_EMBED_WORKER_LEASE_MS;

  async function claimWithFilter(workerId, filter) {
    const NewsVector = getNewsVector();
    const t = new Date(now());
    const leaseExpiresAt = new Date(t.getTime() + leaseMs);
    const update = {
      $set: {
        processingAt: t,
        processingBy: String(workerId || 'unknown'),
        leaseExpiresAt,
      },
    };
    const options = { new: true, sort: { updatedAt: 1 } };
    const doc = await NewsVector.findOneAndUpdate(filter, update, options);
    return doc || null;
  }

  /**
   * Prefer expired-lease reclaim, then fresh unclaimed.
   * @returns {{ doc: object|null, reclaim: boolean }}
   */
  async function claimNextDetailed(workerId) {
    const t = new Date(now());
    const reclaimed = await claimWithFilter(workerId, buildReclaimFilter(t));
    if (reclaimed) {
      return { doc: reclaimed, reclaim: true };
    }
    const fresh = await claimWithFilter(workerId, buildFreshClaimFilter(t));
    if (fresh) {
      return { doc: fresh, reclaim: false };
    }
    return { doc: null, reclaim: false };
  }

  /**
   * @returns {object|null} claimed doc
   */
  async function claimNext(workerId) {
    const result = await claimNextDetailed(workerId);
    return result.doc;
  }

  /**
   * @returns {{ docs: object[], reclaimCount: number, claimLatencyMs: number }}
   */
  async function claimBatch(workerId, limit = 10) {
    const started = now();
    const docs = [];
    let reclaimCount = 0;
    const n = Math.max(0, Math.floor(limit));
    for (let i = 0; i < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await claimNextDetailed(workerId);
      if (!result.doc) break;
      docs.push(result.doc);
      if (result.reclaim) reclaimCount += 1;
    }
    return {
      docs,
      reclaimCount,
      claimLatencyMs: now() - started,
    };
  }

  async function releaseClaim(doc) {
    if (!doc || doc.newsId == null) return { released: false };
    const NewsVector = getNewsVector();
    const embeddingVersion =
      doc.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION;
    await NewsVector.findOneAndUpdate(
      {
        newsId: doc.newsId,
        embeddingVersion,
        modality: C.MODALITY_TEXT,
        status: STATUS.PENDING,
      },
      { $set: { ...CLEAR_CLAIM } }
    );
    return { released: true };
  }

  return {
    claimNext,
    claimNextDetailed,
    claimBatch,
    releaseClaim,
    buildDueAndClaimableFilter,
    buildReclaimFilter,
    buildFreshClaimFilter,
    CLEAR_CLAIM,
    leaseMs,
  };
}

module.exports = {
  createEmbedWorkerClaim,
  buildDueAndClaimableFilter,
  CLEAR_CLAIM,
};
