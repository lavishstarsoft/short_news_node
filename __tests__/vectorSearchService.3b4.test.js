'use strict';

const {
  createVectorSearchService,
  buildVectorSearchPipeline,
  validateQueryEmbedding,
  normalizeMatches,
  DEFAULT_WINDOW_HOURS,
  DEFAULT_TOP_K,
} = require('../services/aiDuplicate/semantic/vectorSearchService');
const C = require('../services/aiDuplicate/semantic/constants');

function vec(n = C.EMBEDDING_DIMENSIONS, fill = 0.1) {
  return Array.from({ length: n }, () => fill);
}

describe('Phase-3B.4 vectorSearchService', () => {
  test('rejects invalid embedding length', () => {
    const r = validateQueryEmbedding(vec(10));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expected 384/);
  });

  test('rejects non-array embedding', () => {
    expect(validateQueryEmbedding(null).ok).toBe(false);
  });

  test('pipeline always filters status READY', () => {
    const { pipeline, meta } = buildVectorSearchPipeline({
      embedding: vec(),
      now: new Date('2026-07-22T12:00:00.000Z'),
    });
    const vs = pipeline[0].$vectorSearch;
    expect(vs.filter.status).toBe('READY');
    expect(meta.status).toBe('READY');
  });

  test('pipeline filters language', () => {
    const { pipeline } = buildVectorSearchPipeline({
      embedding: vec(),
      language: 'HI',
    });
    expect(pipeline[0].$vectorSearch.filter.language).toBe('hi');
  });

  test('pipeline filters embeddingVersion (never cross-version)', () => {
    const { pipeline, meta } = buildVectorSearchPipeline({
      embedding: vec(),
      embeddingVersion: 'e5s-v1',
    });
    expect(pipeline[0].$vectorSearch.filter.embeddingVersion).toBe('e5s-v1');
    expect(meta.embeddingVersion).toBe('e5s-v1');
  });

  test('pipeline applies time window (default 72h, never full scan)', () => {
    const now = new Date('2026-07-22T12:00:00.000Z');
    const { pipeline, meta } = buildVectorSearchPipeline({
      embedding: vec(),
      now,
    });
    const since = pipeline[0].$vectorSearch.filter.publishedAt.$gte;
    expect(meta.windowHours).toBe(DEFAULT_WINDOW_HOURS);
    expect(since.toISOString()).toBe('2026-07-19T12:00:00.000Z');
  });

  test('time window is configurable', () => {
    const now = new Date('2026-07-22T12:00:00.000Z');
    const { pipeline, meta } = buildVectorSearchPipeline({
      embedding: vec(),
      windowHours: 24,
      now,
    });
    expect(meta.windowHours).toBe(24);
    expect(pipeline[0].$vectorSearch.filter.publishedAt.$gte.toISOString()).toBe(
      '2026-07-21T12:00:00.000Z'
    );
  });

  test('projects only allowed fields (no duplicate scores)', () => {
    const { pipeline } = buildVectorSearchPipeline({ embedding: vec() });
    const project = pipeline.find((s) => s.$project).$project;
    expect(project).toEqual({
      _id: 0,
      newsId: 1,
      score: 1,
      publishedAt: 1,
      language: 1,
      embeddingVersion: 1,
    });
    expect(project.duplicateScore).toBeUndefined();
    expect(project.label).toBeUndefined();
  });

  test('Top-K ordering by score descending', () => {
    const ordered = normalizeMatches(
      [
        { newsId: 'a', score: 0.5, publishedAt: null, language: 'te', embeddingVersion: 'e5s-v1' },
        { newsId: 'b', score: 0.9, publishedAt: null, language: 'te', embeddingVersion: 'e5s-v1' },
        { newsId: 'c', score: 0.7, publishedAt: null, language: 'te', embeddingVersion: 'e5s-v1' },
      ],
      2
    );
    expect(ordered.map((m) => m.newsId)).toEqual(['b', 'c']);
    expect(ordered).toHaveLength(2);
  });

  test('searchSimilar returns empty matches when aggregate empty', async () => {
    const collection = {
      aggregate: jest.fn(() => ({
        toArray: async () => [],
      })),
    };
    const svc = createVectorSearchService({ collection });
    const result = await svc.searchSimilar({
      embedding: vec(),
      language: 'te',
      embeddingVersion: 'e5s-v1',
    });
    expect(result.ok).toBe(true);
    expect(result.matches).toEqual([]);
    const filter = collection.aggregate.mock.calls[0][0][0].$vectorSearch.filter;
    expect(filter.status).toBe(C.STATUS.READY);
    expect(filter.language).toBe('te');
    expect(filter.embeddingVersion).toBe('e5s-v1');
    expect(filter.publishedAt.$gte).toBeInstanceOf(Date);
  });

  test('searchSimilar fails fast on bad embedding length (no aggregate)', async () => {
    const collection = { aggregate: jest.fn() };
    const svc = createVectorSearchService({ collection });
    const result = await svc.searchSimilar({ embedding: vec(3) });
    expect(result.ok).toBe(false);
    expect(result.matches).toEqual([]);
    expect(collection.aggregate).not.toHaveBeenCalled();
  });

  test('searchSimilar returns Top-K matches from aggregate', async () => {
    const collection = {
      aggregate: jest.fn(() => ({
        toArray: async () => [
          {
            newsId: 'n1',
            score: 0.81,
            publishedAt: new Date('2026-07-21T00:00:00.000Z'),
            language: 'te',
            embeddingVersion: 'e5s-v1',
          },
          {
            newsId: 'n2',
            score: 0.92,
            publishedAt: new Date('2026-07-22T00:00:00.000Z'),
            language: 'te',
            embeddingVersion: 'e5s-v1',
          },
        ],
      })),
    };
    const svc = createVectorSearchService({ collection });
    const result = await svc.searchSimilar({
      embedding: vec(),
      topK: DEFAULT_TOP_K,
    });
    expect(result.ok).toBe(true);
    expect(result.matches[0].newsId).toBe('n2');
    expect(result.matches[0].score).toBe(0.92);
    expect(Object.keys(result.matches[0]).sort()).toEqual([
      'embeddingVersion',
      'language',
      'newsId',
      'publishedAt',
      'score',
    ]);
  });

  test('cosine + 384 documented in pipeline meta', () => {
    const { meta } = buildVectorSearchPipeline({ embedding: vec() });
    expect(meta.similarity).toBe('cosine');
    expect(meta.dimensions).toBe(384);
  });
});
