'use strict';

const mongoose = require('mongoose');
const {
  createEmbedPendingWorker,
  computeBackoffMs,
  isAiEmbedWorkerEnabled,
  STATUS,
  createNewsVectorPersistence,
} = require('../services/aiDuplicate/semantic');

function validEmbedResponse() {
  return {
    success: true,
    implemented: true,
    phase: '3B.2',
    modelId: 'intfloat/multilingual-e5-small',
    embeddingVersion: 'e5s-v1',
    dimensions: 384,
    embedding: Array.from({ length: 384 }, (_, i) => i * 0.001),
    metadata: {},
  };
}

function createMemoryNewsVector() {
  const store = new Map();

  function keyOf(filter) {
    return `${String(filter.newsId)}|${filter.embeddingVersion}|${filter.modality || 'text'}`;
  }

  function lookup(filter) {
    return store.get(keyOf(filter)) || null;
  }

  function matchesFilter(doc, filter) {
    if (filter.status && doc.status !== filter.status) return false;
    if (filter.newsId && String(doc.newsId) !== String(filter.newsId)) return false;
    if (filter.embeddingVersion && doc.embeddingVersion !== filter.embeddingVersion) {
      return false;
    }
    if (filter.modality && doc.modality !== filter.modality) return false;
    if (filter.$or) {
      const ok = filter.$or.some((clause) => {
        if (Object.prototype.hasOwnProperty.call(clause, 'nextEmbedAt')) {
          const v = clause.nextEmbedAt;
          if (v === null) return doc.nextEmbedAt == null;
          if (v && v.$exists === false) return doc.nextEmbedAt == null;
          if (v && v.$lte) {
            if (doc.nextEmbedAt == null) return true;
            return new Date(doc.nextEmbedAt) <= new Date(v.$lte);
          }
        }
        return false;
      });
      if (!ok) return false;
    }
    return true;
  }

  function matchesClaimFilter(doc, filter) {
    if (filter.status && doc.status !== filter.status) return false;
    if (!filter.$and) return matchesFilter(doc, filter);

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
    findOne(filter) {
      const doc = lookup(filter);
      const clone = doc ? { ...doc } : null;
      return {
        lean: async () => clone,
        then: (resolve, reject) => Promise.resolve(clone).then(resolve, reject),
      };
    },
    find(filter) {
      const rows = [...store.values()]
        .filter((d) => matchesFilter(d, filter))
        .map((d) => ({ ...d }));
      const api = {
        sort() {
          return api;
        },
        limit(n) {
          api._limit = n;
          return api;
        },
        lean: async () => rows.slice(0, api._limit || rows.length),
        then: (resolve, reject) =>
          Promise.resolve(rows.slice(0, api._limit || rows.length)).then(
            resolve,
            reject
          ),
      };
      return api;
    },
    async findOneAndUpdate(filter, update, options = {}) {
      let doc = null;
      if (filter.$and) {
        const candidates = [...store.values()]
          .filter((d) => matchesClaimFilter(d, filter))
          .sort(
            (a, b) =>
              new Date(a.updatedAt || 0).getTime() -
              new Date(b.updatedAt || 0).getTime()
          );
        doc = candidates[0] || null;
      } else {
        doc = lookup(filter);
        if (filter.status && doc && doc.status !== filter.status) {
          if (!(filter.status.$in && filter.status.$in.includes(doc.status))) {
            if (typeof filter.status === 'string' && doc.status !== filter.status) {
              return null;
            }
          }
        }
      }
      if (!doc) {
        if (!options.upsert) return null;
        doc = {
          _id: new mongoose.Types.ObjectId(),
          newsId: filter.newsId,
          embeddingVersion: filter.embeddingVersion,
          modality: filter.modality || 'text',
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
      if (Object.prototype.hasOwnProperty.call(set, 'embedding') && set.embedding === undefined) {
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
      return next;
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
        then: (resolve, reject) =>
          Promise.resolve(doc ? { ...doc } : null).then(resolve, reject),
      };
    },
  };
}

describe('Phase-4.1 embedPendingWorker', () => {
  test('AI_EMBED_WORKER_ENABLED defaults OFF', () => {
    expect(isAiEmbedWorkerEnabled({})).toBe(false);
  });

  test('exponential backoff doubles and caps', () => {
    expect(computeBackoffMs(1, 1000, 100000)).toBe(1000);
    expect(computeBackoffMs(2, 1000, 100000)).toBe(2000);
    expect(computeBackoffMs(3, 1000, 100000)).toBe(4000);
    expect(computeBackoffMs(10, 1000, 5000)).toBe(5000);
  });

  test('worker disabled — processBatch no-op', async () => {
    const NewsVector = createMemoryNewsVector();
    const worker = createEmbedPendingWorker({
      env: { AI_EMBED_WORKER_ENABLED: 'false' },
      NewsVector,
      News: createMemoryNews({}),
      embedText: jest.fn(),
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const out = await worker.processBatch();
    expect(out.ran).toBe(false);
    expect(out.reason).toBe('worker_disabled');
  });

  test('success: PENDING → READY + metrics', async () => {
    const newsId = new mongoose.Types.ObjectId();
    const NewsVector = createMemoryNewsVector();
    const persistence = createNewsVectorPersistence({ NewsVector });
    await persistence.ensurePending({
      newsId,
      contentHash: 'hash-1',
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
          contentHash: 'hash-1',
          language: 'te',
          isActive: true,
          publishedAt: new Date(),
        },
      }),
      persistence,
      embedText: async () => ({
        ok: true,
        embedResponse: validEmbedResponse(),
        latencyMs: 42,
      }),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      config: {
        enabled: true,
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        batchSize: 10,
        pollMs: 5000,
        embedTimeoutMs: 5000,
      },
    });

    const out = await worker.processBatch({ force: true });
    expect(out.ran).toBe(true);
    expect(out.results[0].outcome).toBe('success');
    expect(out.metrics.success).toBe(1);

    const doc = await NewsVector.findOne({
      newsId,
      embeddingVersion: 'e5s-v1',
      modality: 'text',
    }).lean();
    expect(doc.status).toBe(STATUS.READY);
    expect(doc.embedding).toHaveLength(384);
    expect(doc.embedAttempts).toBe(0);
  });

  test('retry on failure then schedule nextEmbedAt', async () => {
    const newsId = new mongoose.Types.ObjectId();
    const NewsVector = createMemoryNewsVector();
    const persistence = createNewsVectorPersistence({ NewsVector });
    await persistence.ensurePending({
      newsId,
      contentHash: 'hash-1',
      language: 'en',
    });

    const worker = createEmbedPendingWorker({
      env: { AI_EMBED_WORKER_ENABLED: 'true' },
      NewsVector,
      News: createMemoryNews({
        [String(newsId)]: {
          _id: newsId,
          title: 'T',
          content: 'C',
          contentHash: 'hash-1',
          language: 'en',
        },
      }),
      persistence,
      embedText: async () => ({ ok: false, error: 'embed_http_503', latencyMs: 5 }),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      now: () => 1_000_000,
      config: {
        enabled: true,
        maxAttempts: 5,
        baseDelayMs: 2000,
        maxDelayMs: 300000,
        batchSize: 10,
        pollMs: 5000,
        embedTimeoutMs: 5000,
      },
    });

    const out = await worker.processBatch({ force: true });
    expect(out.results[0].outcome).toBe('retry');
    expect(out.metrics.retry).toBe(1);

    const doc = await NewsVector.findOne({
      newsId,
      embeddingVersion: 'e5s-v1',
      modality: 'text',
    }).lean();
    expect(doc.status).toBe(STATUS.PENDING);
    expect(doc.embedAttempts).toBe(1);
    expect(new Date(doc.nextEmbedAt).getTime()).toBe(1_000_000 + 2000);
  });

  test('FAILED after max attempts', async () => {
    const newsId = new mongoose.Types.ObjectId();
    const NewsVector = createMemoryNewsVector();
    const persistence = createNewsVectorPersistence({ NewsVector });
    await persistence.ensurePending({
      newsId,
      contentHash: 'hash-1',
      language: 'hi',
    });
    // Pretend already at max-1 attempts
    await NewsVector.findOneAndUpdate(
      { newsId, embeddingVersion: 'e5s-v1', modality: 'text' },
      { $set: { embedAttempts: 4 } }
    );

    const worker = createEmbedPendingWorker({
      env: { AI_EMBED_WORKER_ENABLED: 'true' },
      NewsVector,
      News: createMemoryNews({
        [String(newsId)]: {
          _id: newsId,
          title: 'T',
          content: 'C',
          contentHash: 'hash-1',
          language: 'hi',
        },
      }),
      persistence,
      embedText: async () => ({ ok: false, error: 'embed_request_failed' }),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      config: {
        enabled: true,
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        batchSize: 10,
        pollMs: 5000,
        embedTimeoutMs: 5000,
      },
    });

    const out = await worker.processBatch({ force: true });
    expect(out.results[0].outcome).toBe('failed');
    expect(out.metrics.failure).toBe(1);

    const doc = await NewsVector.findOne({
      newsId,
      embeddingVersion: 'e5s-v1',
      modality: 'text',
    }).lean();
    expect(doc.status).toBe(STATUS.FAILED);
  });

  test('idempotency: READY with embedding is skipped', async () => {
    const newsId = new mongoose.Types.ObjectId();
    const NewsVector = createMemoryNewsVector();
    const persistence = createNewsVectorPersistence({ NewsVector });
    await persistence.persistEmbedSuccess({
      newsId,
      contentHash: 'hash-1',
      language: 'te',
      embedResponse: validEmbedResponse(),
    });

    const embedText = jest.fn();
    const worker = createEmbedPendingWorker({
      env: { AI_EMBED_WORKER_ENABLED: 'true' },
      NewsVector,
      News: createMemoryNews({
        [String(newsId)]: {
          _id: newsId,
          contentHash: 'hash-1',
          title: 'T',
          content: 'C',
          language: 'te',
        },
      }),
      persistence,
      embedText,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      config: {
        enabled: true,
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        batchSize: 10,
        pollMs: 5000,
        embedTimeoutMs: 5000,
      },
    });

    // Force processOne on READY doc
    const doc = await NewsVector.findOne({
      newsId,
      embeddingVersion: 'e5s-v1',
      modality: 'text',
    }).lean();
    const r = await worker.processOne(doc);
    expect(r.outcome).toBe('skipped_unchanged');
    expect(embedText).not.toHaveBeenCalled();
  });

  test('contentHash mismatch refreshes PENDING and skips embed', async () => {
    const newsId = new mongoose.Types.ObjectId();
    const NewsVector = createMemoryNewsVector();
    const persistence = createNewsVectorPersistence({ NewsVector });
    await persistence.ensurePending({
      newsId,
      contentHash: 'old-hash',
      language: 'te',
    });

    const embedText = jest.fn();
    const worker = createEmbedPendingWorker({
      env: { AI_EMBED_WORKER_ENABLED: 'true' },
      NewsVector,
      News: createMemoryNews({
        [String(newsId)]: {
          _id: newsId,
          title: 'T',
          content: 'new',
          contentHash: 'new-hash',
          language: 'te',
        },
      }),
      persistence,
      embedText,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      config: {
        enabled: true,
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        batchSize: 10,
        pollMs: 5000,
        embedTimeoutMs: 5000,
      },
    });

    const out = await worker.processBatch({ force: true });
    expect(out.results[0].outcome).toBe('skipped_hash_mismatch');
    expect(embedText).not.toHaveBeenCalled();
    expect(out.metrics.skipped).toBe(1);

    const doc = await NewsVector.findOne({
      newsId,
      embeddingVersion: 'e5s-v1',
      modality: 'text',
    }).lean();
    expect(doc.status).toBe(STATUS.PENDING);
    expect(doc.contentHash).toBe('new-hash');
  });

  test('status transitions: PENDING stays PENDING on retry', async () => {
    const newsId = new mongoose.Types.ObjectId();
    const NewsVector = createMemoryNewsVector();
    const persistence = createNewsVectorPersistence({ NewsVector });
    await persistence.ensurePending({
      newsId,
      contentHash: 'h',
      language: 'te',
    });

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
      embedText: async () => ({ ok: false, error: 'timeout' }),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      config: {
        enabled: true,
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        batchSize: 5,
        pollMs: 1000,
        embedTimeoutMs: 1000,
      },
    });

    await worker.processBatch({ force: true });
    const doc = await NewsVector.findOne({
      newsId,
      embeddingVersion: 'e5s-v1',
      modality: 'text',
    }).lean();
    expect(doc.status).toBe(STATUS.PENDING);
    expect(doc.embedAttempts).toBe(1);
  });
});
