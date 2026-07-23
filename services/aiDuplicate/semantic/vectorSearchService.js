'use strict';

/**
 * Phase-3B.4 — Atlas Vector Search ONLY.
 *
 * Embedding → Atlas $vectorSearch → Top-K matches.
 * Does NOT decide duplicates, merge Exact/Near, or write DB.
 * Not imported by newsController / gateway / duplicate pipeline.
 */

const C = require('./constants');

const DEFAULT_WINDOW_HOURS = 72;
const DEFAULT_TOP_K = 10;
const DEFAULT_NUM_CANDIDATES_FACTOR = 10;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Validate query embedding before calling Atlas.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateQueryEmbedding(embedding, expectedDims = C.EMBEDDING_DIMENSIONS) {
  if (!Array.isArray(embedding)) {
    return { ok: false, error: 'embedding must be an array' };
  }
  if (embedding.length !== expectedDims) {
    return {
      ok: false,
      error: `embedding length ${embedding.length}; expected ${expectedDims}`,
    };
  }
  for (let i = 0; i < embedding.length; i += 1) {
    if (!isFiniteNumber(embedding[i])) {
      return { ok: false, error: `embedding[${i}] is not a finite number` };
    }
  }
  return { ok: true };
}

/**
 * Build Atlas Vector Search aggregation pipeline (no execution).
 * Documented index name default: news_vectors_embedding_e5s_v1
 */
function buildVectorSearchPipeline(input = {}) {
  const embedding = input.embedding;
  const language = (input.language || 'te').toLowerCase();
  const embeddingVersion = input.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION;
  const windowHours = Number.isFinite(input.windowHours) && input.windowHours > 0
    ? input.windowHours
    : DEFAULT_WINDOW_HOURS;
  const topK = Number.isFinite(input.topK) && input.topK > 0 ? Math.floor(input.topK) : DEFAULT_TOP_K;
  const indexName = input.indexName || 'news_vectors_embedding_e5s_v1';
  const excludeNewsId = input.excludeNewsId ? String(input.excludeNewsId) : null;
  const now = input.now || new Date();
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const numCandidates = Math.max(topK * DEFAULT_NUM_CANDIDATES_FACTOR, topK);

  const filter = {
    status: C.STATUS.READY,
    language,
    embeddingVersion,
    publishedAt: { $gte: since },
  };

  const pipeline = [
    {
      $vectorSearch: {
        index: indexName,
        path: 'embedding',
        queryVector: embedding,
        numCandidates,
        limit: topK,
        filter,
        // Cosine similarity is configured on the Atlas index definition
      },
    },
    {
      $addFields: {
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ];

  if (excludeNewsId) {
    pipeline.push({
      $match: {
        newsId: { $ne: excludeNewsId },
      },
    });
  }

  pipeline.push({
    $project: {
      _id: 0,
      newsId: 1,
      score: 1,
      publishedAt: 1,
      language: 1,
      embeddingVersion: 1,
    },
  });

  return {
    pipeline,
    meta: {
      indexName,
      language,
      embeddingVersion,
      status: C.STATUS.READY,
      windowHours,
      since: since.toISOString(),
      topK,
      numCandidates,
      similarity: 'cosine',
      dimensions: C.EMBEDDING_DIMENSIONS,
    },
  };
}

/**
 * Normalize / sort Top-K results (defensive for mocks / drivers).
 */
function normalizeMatches(rows = [], topK = DEFAULT_TOP_K) {
  const mapped = (rows || [])
    .map((row) => ({
      newsId: row.newsId != null ? String(row.newsId) : null,
      score: typeof row.score === 'number' ? row.score : 0,
      publishedAt: row.publishedAt || null,
      language: row.language || null,
      embeddingVersion: row.embeddingVersion || null,
    }))
    .filter((row) => row.newsId);

  mapped.sort((a, b) => b.score - a.score);
  return mapped.slice(0, topK);
}

function createVectorSearchService(deps = {}) {
  const getCollection = () => {
    if (deps.collection) return deps.collection;
    const NewsVector = deps.NewsVector || require('../../../models/NewsVector');
    return NewsVector.collection;
  };

  /**
   * Run vector search. Returns matches only — never duplicate labels.
   */
  async function searchSimilar(input = {}) {
    const dims = deps.dimensions || C.EMBEDDING_DIMENSIONS;
    const validation = validateQueryEmbedding(input.embedding, dims);
    if (!validation.ok) {
      return {
        ok: false,
        error: validation.error,
        matches: [],
        meta: null,
      };
    }

    const built = buildVectorSearchPipeline(input);
    const collection = getCollection();

    if (!collection || typeof collection.aggregate !== 'function') {
      return {
        ok: false,
        error: 'Vector search collection unavailable',
        matches: [],
        meta: built.meta,
      };
    }

    const cursor = collection.aggregate(built.pipeline);
    const rows = typeof cursor.toArray === 'function' ? await cursor.toArray() : await cursor;
    const matches = normalizeMatches(rows, built.meta.topK);

    return {
      ok: true,
      matches,
      meta: built.meta,
    };
  }

  return {
    searchSimilar,
    buildVectorSearchPipeline,
    validateQueryEmbedding,
    normalizeMatches,
  };
}

const defaultService = createVectorSearchService();

module.exports = {
  createVectorSearchService,
  buildVectorSearchPipeline,
  validateQueryEmbedding,
  normalizeMatches,
  searchSimilar: defaultService.searchSimilar,
  DEFAULT_WINDOW_HOURS,
  DEFAULT_TOP_K,
};
