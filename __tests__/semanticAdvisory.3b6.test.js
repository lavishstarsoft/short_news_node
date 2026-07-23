'use strict';

const {
  createSemanticAdvisoryService,
  filterAndRankCandidates,
  loadAdvisoryThresholds,
  isAiSemanticEnabled,
} = require('../services/aiDuplicate/semantic');
const C = require('../services/aiDuplicate/semantic/constants');

function vec(n = 384, fill = 0.01) {
  return Array.from({ length: n }, () => fill);
}

function buildSvc(overrides = {}) {
  return createSemanticAdvisoryService({
    env: { AI_SEMANTIC_ENABLED: 'true', ...(overrides.env || {}) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    now: overrides.now || (() => Date.now()),
    thresholds: overrides.thresholds,
    embedText: overrides.embedText,
    vectorSearch: overrides.vectorSearch,
    ...overrides,
  });
}

describe('Phase-3B.6 semanticAdvisoryService', () => {
  test('feature flag defaults OFF', () => {
    expect(isAiSemanticEnabled({})).toBe(false);
    expect(isAiSemanticEnabled({ AI_SEMANTIC_ENABLED: 'false' })).toBe(false);
  });

  test('Feature flag OFF — unavailable, no AI / Atlas calls', async () => {
    const embedText = jest.fn();
    const searchSimilar = jest.fn();
    const svc = createSemanticAdvisoryService({
      env: { AI_SEMANTIC_ENABLED: 'false' },
      embedText,
      vectorSearch: { searchSimilar },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    const out = await svc.getSemanticAdvisory({
      title: 'T',
      content: 'C',
      language: 'te',
    });

    expect(out.enabled).toBe(false);
    expect(out.available).toBe(false);
    expect(out.reason).toBe('semantic_disabled');
    expect(out.topCandidate).toBeNull();
    expect(out.candidates).toEqual([]);
    expect(out.advisoryOnly).toBe(true);
    expect(embedText).not.toHaveBeenCalled();
    expect(searchSimilar).not.toHaveBeenCalled();
  });

  test('Feature flag ON — advisory available with topCandidate', async () => {
    const svc = buildSvc({
      embedText: async () => ({
        ok: true,
        embedding: vec(),
        embeddingVersion: 'e5s-v1',
        modelId: 'intfloat/multilingual-e5-small',
        latencyMs: 10,
      }),
      vectorSearch: {
        searchSimilar: async () => ({
          ok: true,
          matches: [
            {
              newsId: 'n-strong',
              score: 0.95,
              language: 'te',
              publishedAt: new Date('2026-07-22T00:00:00.000Z'),
              embeddingVersion: 'e5s-v1',
            },
            {
              newsId: 'n-possible',
              score: 0.89,
              language: 'te',
              publishedAt: new Date('2026-07-21T00:00:00.000Z'),
              embeddingVersion: 'e5s-v1',
            },
          ],
        }),
      },
    });

    const out = await svc.getSemanticAdvisory({
      title: 'T',
      content: 'C',
      language: 'te',
    });

    expect(out.enabled).toBe(true);
    expect(out.available).toBe(true);
    expect(out.topCandidate.newsId).toBe('n-strong');
    expect(out.topCandidate.score).toBe(0.95);
    expect(out.candidates).toHaveLength(2);
    expect(out.candidates[0].strength).toBe('strong');
    expect(out.candidates[1].strength).toBe('possible');
    expect(out.modelId).toBe('intfloat/multilingual-e5-small');
    expect(out.embeddingVersion).toBe('e5s-v1');
    expect(typeof out.latencyMs).toBe('number');
    expect(out.advisoryOnly).toBe(true);
  });

  test('No candidates → available with empty list', async () => {
    const svc = buildSvc({
      embedding: vec(),
      embedText: async () => ({ ok: true, embedding: vec() }),
      vectorSearch: {
        searchSimilar: async () => ({ ok: true, matches: [] }),
      },
    });

    const out = await svc.getSemanticAdvisory({
      language: 'te',
      embedding: vec(),
    });

    expect(out.enabled).toBe(true);
    expect(out.available).toBe(true);
    expect(out.topCandidate).toBeNull();
    expect(out.candidates).toEqual([]);
    expect(out.reason).toBe('no_candidates_above_threshold');
  });

  test('Below threshold filtered out', async () => {
    const ranked = filterAndRankCandidates(
      [
        {
          newsId: 'low',
          score: 0.8,
          language: 'te',
          embeddingVersion: 'e5s-v1',
          publishedAt: null,
        },
      ],
      {
        language: 'te',
        embeddingVersion: 'e5s-v1',
        thresholds: loadAdvisoryThresholds({}),
      }
    );
    expect(ranked).toEqual([]);

    const svc = buildSvc({
      vectorSearch: {
        searchSimilar: async () => ({
          ok: true,
          matches: [
            {
              newsId: 'low',
              score: 0.85,
              language: 'te',
              embeddingVersion: 'e5s-v1',
            },
          ],
        }),
      },
    });

    const out = await svc.getSemanticAdvisory({
      language: 'te',
      embedding: vec(),
    });
    expect(out.available).toBe(true);
    expect(out.topCandidate).toBeNull();
    expect(out.candidates).toEqual([]);
  });

  test('AI embed failure → unavailable fail-open', async () => {
    const svc = buildSvc({
      embedText: async () => ({ ok: false, error: 'embed_http_503' }),
      vectorSearch: { searchSimilar: jest.fn() },
    });

    const out = await svc.getSemanticAdvisory({
      title: 'T',
      content: 'C',
      language: 'te',
    });

    expect(out.enabled).toBe(true);
    expect(out.available).toBe(false);
    expect(out.reason).toBe('embed_http_503');
    expect(out.topCandidate).toBeNull();
  });

  test('Atlas / vector search failure → unavailable fail-open', async () => {
    const svc = buildSvc({
      vectorSearch: {
        searchSimilar: async () => ({
          ok: false,
          error: 'Vector search collection unavailable',
          matches: [],
        }),
      },
    });

    const out = await svc.getSemanticAdvisory({
      language: 'te',
      embedding: vec(),
    });

    expect(out.enabled).toBe(true);
    expect(out.available).toBe(false);
    expect(out.reason).toMatch(/unavailable|vector/i);
    expect(out.candidates).toEqual([]);
  });

  test('Version mismatch filtered (never cross-version)', () => {
    const ranked = filterAndRankCandidates(
      [
        {
          newsId: 'v2',
          score: 0.99,
          language: 'te',
          embeddingVersion: 'e5s-v2',
        },
        {
          newsId: 'v1',
          score: 0.9,
          language: 'te',
          embeddingVersion: 'e5s-v1',
        },
      ],
      {
        language: 'te',
        embeddingVersion: 'e5s-v1',
        thresholds: {
          possible: 0.88,
          strong: 0.92,
          topK: 5,
          minMargin: 0,
        },
      }
    );
    expect(ranked.map((c) => c.newsId)).toEqual(['v1']);
  });

  test('Language mismatch filtered', () => {
    const ranked = filterAndRankCandidates(
      [
        {
          newsId: 'hi',
          score: 0.99,
          language: 'hi',
          embeddingVersion: 'e5s-v1',
        },
        {
          newsId: 'te',
          score: 0.9,
          language: 'te',
          embeddingVersion: 'e5s-v1',
        },
      ],
      {
        language: 'te',
        embeddingVersion: 'e5s-v1',
        thresholds: {
          possible: 0.88,
          strong: 0.92,
          topK: 5,
          minMargin: 0,
        },
      }
    );
    expect(ranked.map((c) => c.newsId)).toEqual(['te']);
  });

  test('Query embeddingVersion mismatch vs forced input → unavailable', async () => {
    const svc = buildSvc({
      embedText: async () => ({
        ok: true,
        embedding: vec(),
        embeddingVersion: 'e5s-v2',
        modelId: C.DEFAULT_MODEL_ID,
      }),
      vectorSearch: { searchSimilar: jest.fn() },
    });

    const out = await svc.getSemanticAdvisory({
      title: 'T',
      content: 'C',
      language: 'te',
      embeddingVersion: 'e5s-v1',
    });

    expect(out.available).toBe(false);
    expect(out.reason).toBe('embedding_version_mismatch');
    expect(svc.loadAdvisoryThresholds).toBeDefined();
  });

  test('Default thresholds match 3B.5.5 recommendations', () => {
    const t = loadAdvisoryThresholds({});
    expect(t.possible).toBe(0.88);
    expect(t.strong).toBe(0.92);
    expect(t.topK).toBe(5);
  });

  test('Advisory does not include duplicate decision fields', async () => {
    const svc = buildSvc({
      vectorSearch: {
        searchSimilar: async () => ({
          ok: true,
          matches: [
            {
              newsId: 'n1',
              score: 0.93,
              language: 'en',
              embeddingVersion: 'e5s-v1',
              publishedAt: null,
            },
          ],
        }),
      },
    });

    const out = await svc.getSemanticAdvisory({
      language: 'en',
      embedding: vec(),
    });

    expect(out.isDuplicate).toBeUndefined();
    expect(out.duplicateCheck).toBeUndefined();
    expect(out.duplicateWarning).toBeUndefined();
  });
});
