'use strict';

const mongoose = require('mongoose');
const {
  createNewsVectorPersistence,
  validateEmbedResponse,
  STATUS,
} = require('../services/aiDuplicate/semantic');

function validEmbedResponse(overrides = {}) {
  return {
    success: true,
    implemented: true,
    phase: '3B.2',
    modelId: 'intfloat/multilingual-e5-small',
    embeddingVersion: 'e5s-v1',
    dimensions: 384,
    embedding: Array.from({ length: 384 }, (_, i) => i * 0.001),
    metadata: { processing_time_ms: 10, text_length: 12, language: 'en' },
    ...overrides,
  };
}

  function createMemoryModel() {
  const store = new Map();

  function keyOf(filter) {
    const newsId = String(filter.newsId);
    const embeddingVersion = filter.embeddingVersion;
    const modality = filter.modality || 'text';
    return `${newsId}|${embeddingVersion}|${modality}`;
  }

  function lookup(filter) {
    // Support find by _id for markStale path if needed
    if (filter._id) {
      for (const doc of store.values()) {
        if (String(doc._id) === String(filter._id)) return doc;
      }
      return null;
    }
    return store.get(keyOf(filter)) || null;
  }

  return {
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
      if (!doc) {
        if (!options.upsert) return null;
        doc = {
          _id: new mongoose.Types.ObjectId(),
          newsId: filter.newsId,
          embeddingVersion: filter.embeddingVersion,
          modality: filter.modality || 'text',
        };
      }
      if (filter.status && filter.status.$in && !filter.status.$in.includes(doc.status)) {
        return null;
      }
      if (filter._id && String(filter._id) !== String(doc._id)) {
        return null;
      }
      const set = (update && update.$set) || {};
      const next = { ...doc, ...set };
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
    _store: store,
  };
}

describe('Phase-3B.3 embed response validation', () => {
  test('accepts valid vector', () => {
    const result = validateEmbedResponse(validEmbedResponse());
    expect(result.ok).toBe(true);
    expect(result.value.embedding).toHaveLength(384);
  });

  test('rejects invalid dimensions', () => {
    const result = validateEmbedResponse(
      validEmbedResponse({ dimensions: 128, embedding: [1, 2, 3] })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/dimensions|length/i);
  });

  test('rejects invalid version', () => {
    const result = validateEmbedResponse(
      validEmbedResponse({ embeddingVersion: 'wrong-v1' })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/embeddingVersion/);
  });

  test('rejects invalid model', () => {
    const result = validateEmbedResponse(
      validEmbedResponse({ modelId: 'other-model' })
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/modelId/);
  });
});

describe('Phase-3B.3 NewsVector persistence', () => {
  const newsId = new mongoose.Types.ObjectId();

  function build() {
    const NewsVector = createMemoryModel();
    return {
      NewsVector,
      persistence: createNewsVectorPersistence({ NewsVector }),
    };
  }

  test('READY transition on valid embed', async () => {
    const { persistence } = build();
    await persistence.ensurePending({
      newsId,
      contentHash: 'hash-1',
      language: 'en',
    });
    const result = await persistence.persistEmbedSuccess({
      newsId,
      contentHash: 'hash-1',
      language: 'en',
      embedResponse: validEmbedResponse(),
    });
    expect(result.persisted).toBe(true);
    expect(result.status).toBe(STATUS.READY);
    expect(result.doc.status).toBe(STATUS.READY);
    expect(result.doc.embedding).toHaveLength(384);
  });

  test('invalid embed does not persist', async () => {
    const { persistence, NewsVector } = build();
    await persistence.ensurePending({
      newsId,
      contentHash: 'hash-1',
      language: 'en',
    });
    const result = await persistence.persistEmbedSuccess({
      newsId,
      contentHash: 'hash-1',
      embedResponse: validEmbedResponse({ dimensions: 16, embedding: [1] }),
    });
    expect(result.persisted).toBe(false);
    const lean = await NewsVector.findOne({
      newsId,
      embeddingVersion: 'e5s-v1',
      modality: 'text',
    }).lean();
    expect(lean.status).toBe(STATUS.PENDING);
    expect(lean.embedding).toBeUndefined();
  });

  test('FAILED transition', async () => {
    const { persistence } = build();
    const result = await persistence.persistEmbedFailure({
      newsId,
      contentHash: 'hash-1',
      language: 'te',
      error: 'model unavailable',
    });
    expect(result.persisted).toBe(true);
    expect(result.status).toBe(STATUS.FAILED);
    expect(result.doc.lastError).toMatch(/unavailable/);
  });

  test('STALE transition', async () => {
    const { persistence } = build();
    await persistence.persistEmbedSuccess({
      newsId,
      contentHash: 'hash-1',
      language: 'en',
      embedResponse: validEmbedResponse(),
    });
    const stale = await persistence.markStale({ newsId });
    expect(stale.updated).toBe(true);
    expect(stale.status).toBe(STATUS.STALE);
    expect(stale.doc.status).toBe(STATUS.STALE);
  });

  test('contentHash change marks STALE then PENDING without enqueue', async () => {
    const { persistence } = build();
    await persistence.persistEmbedSuccess({
      newsId,
      contentHash: 'hash-old',
      language: 'en',
      embedResponse: validEmbedResponse(),
    });
    const result = await persistence.markStaleAndPrepareReembed({
      newsId,
      previousContentHash: 'hash-old',
      nextContentHash: 'hash-new',
      language: 'en',
      title: 't',
      content: 'c',
    });
    expect(result.changed).toBe(true);
    expect(result.enqueued).toBe(false);
    expect(result.preparedJob.meta.executable).toBe(false);
    expect(result.pendingDoc.status).toBe(STATUS.PENDING);
    expect(result.pendingDoc.contentHash).toBe('hash-new');
  });
});
