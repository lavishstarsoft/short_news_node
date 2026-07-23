'use strict';

const mongoose = require('mongoose');
const {
  createEmbedWorkerClaim,
  createEmbedPendingWorker,
  createNewsVectorPersistence,
  STATUS,
} = require('../services/aiDuplicate/semantic');

function createClaimAwareMemoryModel() {
  const store = new Map();

  function keyOf(parts) {
    return `${String(parts.newsId)}|${parts.embeddingVersion}|${parts.modality || 'text'}`;
  }

  function lookupKey(filter) {
    if (filter.newsId != null && filter.embeddingVersion) {
      return keyOf(filter);
    }
    return null;
  }

  function matchesClaimFilter(doc, filter, nowDate) {
    if (filter.status && doc.status !== filter.status) return false;
    if (!filter.$and) {
      if (filter.newsId && String(doc.newsId) !== String(filter.newsId)) return false;
      if (filter.embeddingVersion && doc.embeddingVersion !== filter.embeddingVersion) {
        return false;
      }
      if (filter.modality && doc.modality !== filter.modality) return false;
      if (filter.status && typeof filter.status === 'string' && doc.status !== filter.status) {
        return false;
      }
      return true;
    }

    function matchOr(orList) {
      return orList.some((clause) => {
        if (Object.prototype.hasOwnProperty.call(clause, 'nextEmbedAt')) {
          const v = clause.nextEmbedAt;
          if (v === null) return doc.nextEmbedAt == null;
          if (v && v.$exists === false) return doc.nextEmbedAt == null;
          if (v && v.$lte) {
            if (doc.nextEmbedAt == null) return true;
            return new Date(doc.nextEmbedAt) <= new Date(v.$lte);
          }
        }
        if (Object.prototype.hasOwnProperty.call(clause, 'leaseExpiresAt')) {
          const v = clause.leaseExpiresAt;
          if (v === null) return doc.leaseExpiresAt == null;
          if (v && v.$exists === false) return doc.leaseExpiresAt == null;
          if (v && v.$lte) {
            if (doc.leaseExpiresAt == null) return true;
            return new Date(doc.leaseExpiresAt) <= new Date(v.$lte);
          }
        }
        return false;
      });
    }

    function matchClause(clause) {
      if (clause.$or) return matchOr(clause.$or);
      if (Object.prototype.hasOwnProperty.call(clause, 'leaseExpiresAt')) {
        const v = clause.leaseExpiresAt;
        if (v === null) return doc.leaseExpiresAt == null;
        if (v && v.$exists === false) return doc.leaseExpiresAt == null;
        if (v && v.$lte) {
          if (doc.leaseExpiresAt == null) return false;
          return new Date(doc.leaseExpiresAt) <= new Date(v.$lte);
        }
      }
      if (Object.prototype.hasOwnProperty.call(clause, 'nextEmbedAt')) {
        const v = clause.nextEmbedAt;
        if (v === null) return doc.nextEmbedAt == null;
        if (v && v.$exists === false) return doc.nextEmbedAt == null;
        if (v && v.$lte) {
          if (doc.nextEmbedAt == null) return true;
          return new Date(doc.nextEmbedAt) <= new Date(v.$lte);
        }
      }
      if (clause.status) return doc.status === clause.status;
      return true;
    }

    return filter.$and.every((clause) => matchClause(clause));
  }

  return {
    _store: store,
    seed(doc) {
      const d = {
        embedAttempts: 0,
        nextEmbedAt: null,
        processingAt: null,
        processingBy: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
        modality: 'text',
        embeddingVersion: 'e5s-v1',
        ...doc,
      };
      store.set(
        keyOf({
          newsId: d.newsId,
          embeddingVersion: d.embeddingVersion,
          modality: d.modality,
        }),
        d
      );
      return d;
    },
    findOne(filter) {
      const k = lookupKey(filter);
      const doc = k ? store.get(k) : null;
      const clone = doc ? { ...doc } : null;
      return {
        lean: async () => clone,
        then: (resolve, reject) => Promise.resolve(clone).then(resolve, reject),
      };
    },
    async findOneAndUpdate(filter, update, options = {}) {
      let doc = null;

      const k = lookupKey(filter);
      if (k && !filter.$and) {
        doc = store.get(k) || null;
        if (filter.status && doc) {
          if (typeof filter.status === 'string' && doc.status !== filter.status) {
            return null;
          }
          if (filter.status.$in && !filter.status.$in.includes(doc.status)) {
            return null;
          }
        }
      } else {
        const candidates = [...store.values()]
          .filter((d) => matchesClaimFilter(d, filter))
          .sort((a, b) => {
            const ta = new Date(a.updatedAt || 0).getTime();
            const tb = new Date(b.updatedAt || 0).getTime();
            return ta - tb;
          });
        doc = candidates[0] || null;
      }

      if (!doc) {
        if (!options.upsert) return null;
        doc = {
          _id: new mongoose.Types.ObjectId(),
          newsId: filter.newsId,
          embeddingVersion: filter.embeddingVersion || 'e5s-v1',
          modality: filter.modality || 'text',
          status: STATUS.PENDING,
          embedAttempts: 0,
          nextEmbedAt: null,
          processingAt: null,
          processingBy: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        };
      }

      const set = (update && update.$set) || {};
      const next = { ...doc, ...set, updatedAt: new Date() };
      if (
        Object.prototype.hasOwnProperty.call(set, 'embedding') &&
        set.embedding === undefined
      ) {
        delete next.embedding;
      }
      store.set(
        keyOf({
          newsId: next.newsId,
          embeddingVersion: next.embeddingVersion,
          modality: next.modality,
        }),
        next
      );
      return options.new === false ? doc : next;
    },
  };
}

function createMemoryNews(docsById) {
  return {
    findById(id) {
      const doc = docsById[String(id)] || null;
      return {
        select() {
          return this;
        },
        lean: async () => (doc ? { ...doc } : null),
      };
    },
  };
}

function validEmbedResponse() {
  return {
    success: true,
    implemented: true,
    phase: '3B.2',
    modelId: 'intfloat/multilingual-e5-small',
    embeddingVersion: 'e5s-v1',
    dimensions: 384,
    embedding: Array.from({ length: 384 }, () => 0.01),
    metadata: {},
  };
}

describe('Phase-4.2.6 embed worker claim/lease', () => {
  test('Single worker claims and processes to READY', async () => {
    const NewsVector = createClaimAwareMemoryModel();
    const newsId = new mongoose.Types.ObjectId();
    const persistence = createNewsVectorPersistence({ NewsVector });
    await persistence.ensurePending({
      newsId,
      contentHash: 'h1',
      language: 'te',
    });

    const worker = createEmbedPendingWorker({
      env: { AI_EMBED_WORKER_ENABLED: 'true' },
      NewsVector,
      News: createMemoryNews({
        [String(newsId)]: {
          _id: newsId,
          title: 'T',
          content: 'C',
          contentHash: 'h1',
          language: 'te',
          isActive: true,
        },
      }),
      persistence,
      workerId: 'worker-a',
      embedText: async () => ({
        ok: true,
        embedResponse: validEmbedResponse(),
        latencyMs: 10,
      }),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      config: {
        enabled: true,
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        batchSize: 5,
        pollMs: 1000,
        embedTimeoutMs: 5000,
        leaseMs: 60000,
      },
      now: () => Date.now(),
    });

    const out = await worker.processBatch({ force: true });
    expect(out.claimed).toBe(1);
    expect(out.results[0].outcome).toBe('success');

    const doc = await NewsVector.findOne({
      newsId,
      embeddingVersion: 'e5s-v1',
      modality: 'text',
    }).lean();
    expect(doc.status).toBe(STATUS.READY);
    expect(doc.processingBy).toBeNull();
    expect(doc.leaseExpiresAt).toBeNull();
  });

  test('Two workers — only one claims the same PENDING', async () => {
    const NewsVector = createClaimAwareMemoryModel();
    const newsId = new mongoose.Types.ObjectId();
    NewsVector.seed({
      newsId,
      contentHash: 'h',
      language: 'en',
      status: STATUS.PENDING,
    });

    let clock = 1_000_000;
    const claimA = createEmbedWorkerClaim({
      NewsVector,
      now: () => clock,
      leaseMs: 60_000,
    });
    const claimB = createEmbedWorkerClaim({
      NewsVector,
      now: () => clock,
      leaseMs: 60_000,
    });

    const a = await claimA.claimNext('worker-a');
    const b = await claimB.claimNext('worker-b');

    expect(a).not.toBeNull();
    expect(a.processingBy).toBe('worker-a');
    expect(b).toBeNull();
  });

  test('Crash recovery — expired lease becomes claimable again', async () => {
    const NewsVector = createClaimAwareMemoryModel();
    const newsId = new mongoose.Types.ObjectId();
    NewsVector.seed({
      newsId,
      contentHash: 'h',
      language: 'te',
      status: STATUS.PENDING,
      processingBy: 'dead-worker',
      processingAt: new Date(1_000_000),
      leaseExpiresAt: new Date(1_030_000),
    });

    let clock = 1_020_000; // still within lease
    const claim = createEmbedWorkerClaim({
      NewsVector,
      now: () => clock,
      leaseMs: 60_000,
    });
    expect(await claim.claimNext('worker-b')).toBeNull();

    clock = 1_030_001; // lease expired
    const recovered = await claim.claimNext('worker-b');
    expect(recovered).not.toBeNull();
    expect(recovered.processingBy).toBe('worker-b');
  });

  test('Expired lease — retry after lease expiry processes successfully', async () => {
    const NewsVector = createClaimAwareMemoryModel();
    const newsId = new mongoose.Types.ObjectId();
    const persistence = createNewsVectorPersistence({ NewsVector });
    await persistence.ensurePending({
      newsId,
      contentHash: 'h',
      language: 'hi',
    });

    // Simulate crashed claim
    await NewsVector.findOneAndUpdate(
      { newsId, embeddingVersion: 'e5s-v1', modality: 'text' },
      {
        $set: {
          processingBy: 'crashed',
          processingAt: new Date(1000),
          leaseExpiresAt: new Date(5000),
        },
      }
    );

    let clock = 6000;
    const worker = createEmbedPendingWorker({
      env: { AI_EMBED_WORKER_ENABLED: 'true' },
      NewsVector,
      News: createMemoryNews({
        [String(newsId)]: {
          _id: newsId,
          title: 't',
          content: 'c',
          contentHash: 'h',
          language: 'hi',
        },
      }),
      persistence,
      workerId: 'worker-recover',
      embedText: async () => ({
        ok: true,
        embedResponse: validEmbedResponse(),
        latencyMs: 5,
      }),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      now: () => clock,
      config: {
        enabled: true,
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        batchSize: 5,
        pollMs: 1000,
        embedTimeoutMs: 5000,
        leaseMs: 60_000,
      },
    });

    const out = await worker.processBatch({ force: true });
    expect(out.claimed).toBe(1);
    expect(out.results[0].outcome).toBe('success');
  });

  test('Retry clears claim so another worker can take after nextEmbedAt', async () => {
    const NewsVector = createClaimAwareMemoryModel();
    const newsId = new mongoose.Types.ObjectId();
    const persistence = createNewsVectorPersistence({ NewsVector });
    await persistence.ensurePending({
      newsId,
      contentHash: 'h',
      language: 'te',
    });

    let clock = 1_000_000;
    const worker = createEmbedPendingWorker({
      env: { AI_EMBED_WORKER_ENABLED: 'true' },
      NewsVector,
      News: createMemoryNews({
        [String(newsId)]: {
          _id: newsId,
          title: 't',
          content: 'c',
          contentHash: 'h',
          language: 'te',
        },
      }),
      persistence,
      workerId: 'worker-retry',
      embedText: async () => ({ ok: false, error: 'embed_http_503' }),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      now: () => clock,
      config: {
        enabled: true,
        maxAttempts: 5,
        baseDelayMs: 2000,
        maxDelayMs: 300000,
        batchSize: 5,
        pollMs: 1000,
        embedTimeoutMs: 5000,
        leaseMs: 60_000,
      },
    });

    const out = await worker.processBatch({ force: true });
    expect(out.results[0].outcome).toBe('retry');

    const doc = await NewsVector.findOne({
      newsId,
      embeddingVersion: 'e5s-v1',
      modality: 'text',
    }).lean();
    expect(doc.status).toBe(STATUS.PENDING);
    expect(doc.processingBy).toBeNull();
    expect(doc.leaseExpiresAt).toBeNull();
    expect(doc.embedAttempts).toBe(1);
    expect(new Date(doc.nextEmbedAt).getTime()).toBe(1_000_000 + 2000);

    // Too early for next attempt
    const claim = createEmbedWorkerClaim({
      NewsVector,
      now: () => clock,
      leaseMs: 60_000,
    });
    expect(await claim.claimNext('other')).toBeNull();

    // After backoff window
    clock = 1_000_000 + 2001;
    const again = await claim.claimNext('other');
    expect(again).not.toBeNull();
    expect(again.processingBy).toBe('other');
  });
});
