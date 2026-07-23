'use strict';

const mongoose = require('mongoose');
const {
  createNewsVectorPendingScheduler,
  createNewsVectorPersistence,
  STATUS,
} = require('../services/aiDuplicate/semantic');

function createMemoryNewsVector() {
  const store = new Map();

  function keyOf(filter) {
    return `${String(filter.newsId)}|${filter.embeddingVersion}|${filter.modality || 'text'}`;
  }

  function lookup(filter) {
    return store.get(keyOf(filter)) || null;
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
    async findOneAndUpdate(filter, update, options = {}) {
      let doc = lookup(filter);
      if (filter.status && doc) {
        if (filter.status.$in && !filter.status.$in.includes(doc.status)) {
          return null;
        }
        if (typeof filter.status === 'string' && doc.status !== filter.status) {
          return null;
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
        };
      }
      const set = (update && update.$set) || {};
      const next = { ...doc, ...set };
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
      return next;
    },
  };
}

describe('Phase-4.2 scheduleNewsVectorPending', () => {
  test('Create → PENDING via ensurePending', async () => {
    const NewsVector = createMemoryNewsVector();
    const persistence = createNewsVectorPersistence({ NewsVector });
    const ensurePending = jest.fn(persistence.ensurePending.bind(persistence));
    const scheduler = createNewsVectorPendingScheduler({
      persistence: {
        ensurePending,
        markStaleAndPrepareReembed: persistence.markStaleAndPrepareReembed,
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    const newsId = new mongoose.Types.ObjectId();
    const result = await scheduler.enqueueCreate({
      _id: newsId,
      contentHash: 'hash-create',
      language: 'te',
      isActive: true,
      publishedAt: new Date('2026-07-22T00:00:00.000Z'),
      title: 'T',
      content: 'C',
    });

    expect(result.ok).toBe(true);
    expect(ensurePending).toHaveBeenCalled();
    const doc = await NewsVector.findOne({
      newsId,
      embeddingVersion: 'e5s-v1',
      modality: 'text',
    }).lean();
    expect(doc.status).toBe(STATUS.PENDING);
    expect(doc.contentHash).toBe('hash-create');
  });

  test('Update unchanged contentHash → do nothing', async () => {
    const NewsVector = createMemoryNewsVector();
    const persistence = createNewsVectorPersistence({ NewsVector });
    const markStaleAndPrepareReembed = jest.fn(
      persistence.markStaleAndPrepareReembed.bind(persistence)
    );
    const scheduler = createNewsVectorPendingScheduler({
      persistence: {
        ensurePending: persistence.ensurePending,
        markStaleAndPrepareReembed,
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    const newsId = new mongoose.Types.ObjectId();
    await persistence.ensurePending({
      newsId,
      contentHash: 'same',
      language: 'en',
    });

    const result = await scheduler.enqueueUpdate({
      previousContentHash: 'same',
      news: {
        _id: newsId,
        contentHash: 'same',
        language: 'en',
        title: 'T',
        content: 'C',
      },
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe('unchanged');
    expect(markStaleAndPrepareReembed).not.toHaveBeenCalled();
  });

  test('Update changed → STALE then PENDING', async () => {
    const NewsVector = createMemoryNewsVector();
    const persistence = createNewsVectorPersistence({ NewsVector });
    const newsId = new mongoose.Types.ObjectId();

    // Existing READY vector
    await persistence.persistEmbedSuccess({
      newsId,
      contentHash: 'old-hash',
      language: 'te',
      embedResponse: {
        success: true,
        implemented: true,
        phase: '3B.2',
        modelId: 'intfloat/multilingual-e5-small',
        embeddingVersion: 'e5s-v1',
        dimensions: 384,
        embedding: Array.from({ length: 384 }, () => 0.1),
        metadata: {},
      },
    });

    const scheduler = createNewsVectorPendingScheduler({
      persistence,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    const result = await scheduler.enqueueUpdate({
      previousContentHash: 'old-hash',
      news: {
        _id: newsId,
        contentHash: 'new-hash',
        language: 'te',
        title: 'T2',
        content: 'C2',
        isActive: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.reason).toBe('stale_then_pending');

    const doc = await NewsVector.findOne({
      newsId,
      embeddingVersion: 'e5s-v1',
      modality: 'text',
    }).lean();
    // Same unique key: ends as PENDING with new hash (STALE applied then overwritten)
    expect(doc.status).toBe(STATUS.PENDING);
    expect(doc.contentHash).toBe('new-hash');
  });

  test('STALE transition occurs when READY vector exists before re-PENDING', async () => {
    const NewsVector = createMemoryNewsVector();
    const persistence = createNewsVectorPersistence({ NewsVector });
    const newsId = new mongoose.Types.ObjectId();
    await persistence.persistEmbedSuccess({
      newsId,
      contentHash: 'a',
      language: 'hi',
      embedResponse: {
        success: true,
        implemented: true,
        phase: '3B.2',
        modelId: 'intfloat/multilingual-e5-small',
        embeddingVersion: 'e5s-v1',
        dimensions: 384,
        embedding: Array.from({ length: 384 }, () => 0.2),
        metadata: {},
      },
    });

    const statuses = [];
    const origMarkStale = persistence.markStale.bind(persistence);
    persistence.markStale = async (input) => {
      const r = await origMarkStale(input);
      statuses.push(r.status);
      return r;
    };

    // Re-bind markStaleAndPrepareReembed to use patched markStale via create?
    // Call markStaleAndPrepareReembed from a fresh persistence that uses same store —
    // instead spy via scheduler path using wrapped persistence.
    const wrapped = {
      ensurePending: persistence.ensurePending.bind(persistence),
      markStaleAndPrepareReembed: async (input) => {
        const staleResult = await persistence.markStale({
          newsId: input.newsId,
          embeddingVersion: input.embeddingVersion,
        });
        statuses.push(staleResult.status);
        const pendingDoc = await persistence.ensurePending({
          newsId: input.newsId,
          contentHash: input.nextContentHash,
          language: input.language,
          isActive: input.isActive,
          publishedAt: input.publishedAt,
          embeddingVersion: input.embeddingVersion,
        });
        return {
          changed: true,
          staleResult,
          pendingDoc,
        };
      },
    };

    const scheduler = createNewsVectorPendingScheduler({
      persistence: wrapped,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    await scheduler.enqueueUpdate({
      previousContentHash: 'a',
      news: {
        _id: newsId,
        contentHash: 'b',
        language: 'hi',
        title: 'x',
        content: 'y',
      },
    });

    expect(statuses).toContain(STATUS.STALE);
    const doc = await NewsVector.findOne({
      newsId,
      embeddingVersion: 'e5s-v1',
      modality: 'text',
    }).lean();
    expect(doc.status).toBe(STATUS.PENDING);
  });

  test('ensurePending failure does not fail publish (schedule swallows errors)', async () => {
    const errors = [];
    const scheduler = createNewsVectorPendingScheduler({
      persistence: {
        ensurePending: async () => {
          throw new Error('mongo down');
        },
        markStaleAndPrepareReembed: async () => {
          throw new Error('mongo down');
        },
      },
      log: {
        info() {},
        warn(msg, obj) {
          errors.push({ msg, obj });
        },
        error() {},
        debug() {},
      },
      scheduleFn: (fn) => fn(), // run inline for test
    });

    const scheduled = scheduler.schedulePendingAfterCreate({
      _id: new mongoose.Types.ObjectId(),
      contentHash: 'h',
      language: 'te',
    });
    expect(scheduled.scheduled).toBe(true);

    // Allow microtask
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));

    expect(errors.some((e) => /failed/i.test(e.msg))).toBe(true);
  });

  test('schedulePendingAfterUpdate returns immediately (fire-and-forget)', () => {
    let started = false;
    const scheduler = createNewsVectorPendingScheduler({
      persistence: {
        ensurePending: async () => {
          started = true;
        },
        markStaleAndPrepareReembed: async () => {
          started = true;
          return { changed: false };
        },
      },
      scheduleFn: () => {
        /* intentionally never run */
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    const out = scheduler.schedulePendingAfterUpdate({
      previousContentHash: 'a',
      news: {
        _id: new mongoose.Types.ObjectId(),
        contentHash: 'b',
        language: 'te',
      },
    });
    expect(out.scheduled).toBe(true);
    expect(started).toBe(false);
  });
});
