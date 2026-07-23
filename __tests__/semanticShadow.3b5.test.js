'use strict';

const {
  isAiSemanticShadowEnabled,
  createSemanticShadowService,
  buildShadowMetric,
  assertMetricHasNoArticleText,
  extractExactNearSnapshots,
} = require('../services/aiDuplicate/semantic');
const { createGateway } = require('../services/aiDuplicate/runDuplicateCheckGateway');
const { createCircuitBreaker } = require('../services/aiDuplicate/circuitBreaker');
const { mapAiResponseToDuplicateCheck } = require('../services/aiDuplicate/mapAiToLegacy');

function vec(n = 384, fill = 0.01) {
  return Array.from({ length: n }, () => fill);
}

describe('Phase-3B.5 semantic shadow', () => {
  test('AI_SEMANTIC_SHADOW_ENABLED defaults OFF', () => {
    expect(isAiSemanticShadowEnabled({})).toBe(false);
    expect(isAiSemanticShadowEnabled({ AI_SEMANTIC_SHADOW_ENABLED: 'false' })).toBe(
      false
    );
  });

  test('Shadow OFF — evaluate does not run semantic or persist', async () => {
    const saveMetric = jest.fn();
    const searchSimilar = jest.fn();
    const embedText = jest.fn();
    const svc = createSemanticShadowService({
      env: { AI_SEMANTIC_SHADOW_ENABLED: 'false' },
      store: { saveMetric },
      vectorSearch: { searchSimilar },
      embedText,
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    const out = await svc.evaluate({
      language: 'te',
      title: 'SECRET TITLE',
      content: 'SECRET BODY',
      duplicateCheck: { score: 80, similarArticles: [] },
    });

    expect(out.executed).toBe(false);
    expect(out.reason).toBe('shadow_disabled');
    expect(saveMetric).not.toHaveBeenCalled();
    expect(searchSimilar).not.toHaveBeenCalled();
    expect(embedText).not.toHaveBeenCalled();
  });

  test('Shadow ON — metrics generated and isolated from duplicateCheck', async () => {
    const saved = [];
    const duplicateCheck = {
      isDuplicate: true,
      isSuspicious: false,
      score: 82,
      matchCount: 1,
      similarArticles: [
        {
          articleId: 'near-1',
          articleTitle: 'should-not-persist',
          content: 'should-not-persist',
          similarity: { overall: 82 },
          isDuplicate: true,
        },
      ],
    };
    const frozen = JSON.stringify(duplicateCheck);

    const svc = createSemanticShadowService({
      env: { AI_SEMANTIC_SHADOW_ENABLED: 'true' },
      store: {
        saveMetric: async (metric) => {
          saved.push(metric);
          return { ok: true, id: 'm1' };
        },
      },
      embedText: async () => ({
        ok: true,
        embedding: vec(),
        embeddingVersion: 'e5s-v1',
        modelId: 'intfloat/multilingual-e5-small',
        latencyMs: 12,
      }),
      vectorSearch: {
        searchSimilar: async () => ({
          ok: true,
          matches: [
            {
              newsId: 'sem-9',
              score: 0.91,
              publishedAt: new Date(),
              language: 'te',
              embeddingVersion: 'e5s-v1',
            },
          ],
          meta: { embeddingVersion: 'e5s-v1' },
        }),
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
      now: (() => {
        let t = 1000;
        return () => {
          t += 5;
          return t;
        };
      })(),
    });

    const out = await svc.evaluate({
      requestId: 'r1',
      newsId: 'n1',
      language: 'te',
      title: 'Never store this title',
      content: 'Never store this body',
      duplicateCheck,
      source: 'legacy',
    });

    expect(out.executed).toBe(true);
    expect(out.persisted).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0].semanticScore).toBe(0.91);
    expect(saved[0].semanticCandidateId).toBe('sem-9');
    expect(saved[0].nearScore).toBe(82);
    expect(saved[0].nearCandidateId).toBe('near-1');
    expect(saved[0].embeddingVersion).toBe('e5s-v1');
    expect(saved[0].modelId).toBe('intfloat/multilingual-e5-small');
    expect(saved[0].title).toBeUndefined();
    expect(saved[0].content).toBeUndefined();
    expect(assertMetricHasNoArticleText(saved[0]).ok).toBe(true);
    // Original duplicateCheck unchanged
    expect(JSON.stringify(duplicateCheck)).toBe(frozen);
    expect(duplicateCheck.isDuplicate).toBe(true);
    expect(duplicateCheck.score).toBe(82);
  });

  test('Metric schema rejects article text fields', () => {
    const bad = buildShadowMetric({});
    bad.title = 'x';
    expect(assertMetricHasNoArticleText(bad).ok).toBe(false);
  });

  test('Shadow ON schedule is no-op when OFF', () => {
    const evaluate = jest.fn();
    const svc = createSemanticShadowService({
      env: { AI_SEMANTIC_SHADOW_ENABLED: 'false' },
      scheduleFn: (fn) => fn(),
    });
    // override evaluate via schedule path — schedule checks flag first
    const out = svc.schedule({ language: 'te' });
    expect(out.scheduled).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
  });

  test('No duplicate decision fields produced by shadow', async () => {
    const saved = [];
    const svc = createSemanticShadowService({
      env: { AI_SEMANTIC_SHADOW_ENABLED: 'true' },
      store: {
        saveMetric: async (metric) => {
          saved.push(metric);
          return { ok: true, id: 'm2' };
        },
      },
      embedding: vec(),
      embedText: async () => ({
        ok: true,
        embedding: vec(),
        latencyMs: 1,
      }),
      vectorSearch: {
        searchSimilar: async () => ({
          ok: true,
          matches: [],
          meta: {},
        }),
      },
      log: { info() {}, warn() {}, error() {}, debug() {} },
    });

    const out = await svc.evaluate({
      language: 'en',
      embedding: vec(),
      duplicateCheck: { score: 0, similarArticles: [] },
    });

    expect(out.metric.isDuplicate).toBeUndefined();
    expect(out.metric.duplicateWarning).toBeUndefined();
    expect(out.metric.label).toBeUndefined();
    expect(saved[0].isDuplicate).toBeUndefined();
  });

  test('extractExactNearSnapshots prefers AI exact/near without copying content', () => {
    const snap = extractExactNearSnapshots({
      aiExact: {
        matched: true,
        score: 100,
        matched_candidate_id: 'ex1',
      },
      aiNear: {
        best_score: 77,
        matches: [{ candidate_id: 'n1', score: 77 }],
      },
      duplicateCheck: {
        similarArticles: [
          { articleId: 'x', articleTitle: 'T', content: 'C', similarity: { overall: 50 } },
        ],
      },
    });
    expect(snap.exact).toEqual({
      matched: true,
      score: 100,
      candidateId: 'ex1',
    });
    expect(snap.near.candidateId).toBe('n1');
    expect(snap.near.score).toBe(77);
    expect(JSON.stringify(snap)).not.toMatch(/articleTitle|"content"/);
  });
});

describe('Phase-3B.5 gateway output unchanged with shadow', () => {
  const legacyResult = {
    contentHash: 'legacy-hash',
    duplicateCheck: {
      isDuplicate: false,
      isSuspicious: false,
      score: 0,
      matchCount: 0,
      checkedAt: new Date('2026-07-22T00:00:00.000Z'),
      similarArticles: [],
    },
  };

  test('Shadow OFF — gateway return identical; schedule not invoked for work', async () => {
    const shadowSchedule = jest.fn(() => ({ scheduled: false }));
    const gateway = createGateway({
      env: {
        AI_DUPLICATE_ENABLED: 'false',
        AI_SEMANTIC_SHADOW_ENABLED: 'false',
      },
      runDuplicateCheck: jest.fn().mockResolvedValue(legacyResult),
      semanticShadow: {
        schedule: shadowSchedule,
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      uuid: () => 'req-1',
    });

    const result = await gateway.runDuplicateCheckGateway({
      title: 'T',
      content: 'C',
      language: 'en',
    });

    expect(result.contentHash).toBe('legacy-hash');
    expect(result.duplicateCheck.isDuplicate).toBe(false);
    expect(result.duplicateCheck.score).toBe(0);
    // schedule may be called but shadow.schedule returns disabled — still ok
    expect(shadowSchedule).toHaveBeenCalled();
    expect(shadowSchedule.mock.results[0].value.scheduled).toBe(false);
  });

  test('Shadow ON — API response fields unchanged; metrics path separate', async () => {
    const aiPayload = {
      implemented: true,
      phase: 2,
      algorithm_version: 'text-exact-near-v1',
      advisory: true,
      query: {
        news_id: null,
        language: 'en',
        title_normalized: 'hello',
        content_hash: 'abc',
      },
      exact: {
        matched: false,
        score: 0,
        matched_candidate_id: null,
        matched_content_hash: null,
      },
      near: {
        matched: true,
        best_score: 82,
        matches: [
          {
            candidate_id: 'c1',
            score: 82,
            title_score: 80,
            content_score: 70,
            keyword_score: 60,
            label: 'very_similar',
          },
        ],
      },
      overall: {
        score: 82,
        label: 'very_similar',
        is_duplicate: true,
        is_suspicious: false,
      },
      candidates_scored: 1,
      message: 'advisory',
    };

    const expectedDc = mapAiResponseToDuplicateCheck(aiPayload, [
      { id: 'c1', title: 'Hello', content: 'World' },
    ]);

    let scheduledInput = null;
    const gateway = createGateway({
      env: {
        AI_DUPLICATE_ENABLED: 'true',
        AI_SERVICE_URL: 'http://localhost:8090',
        AI_SERVICE_API_KEY: 'test-key',
        AI_SEMANTIC_SHADOW_ENABLED: 'true',
      },
      runDuplicateCheck: jest.fn().mockResolvedValue(legacyResult),
      fetchAiCandidates: jest.fn().mockResolvedValue([
        { id: 'c1', title: 'Hello', content: 'World' },
      ]),
      generateContentHash: jest.fn().mockReturnValue('node-md5'),
      httpClient: {
        detectDuplicate: jest.fn().mockResolvedValue({
          ok: true,
          source: 'ai',
          data: aiPayload,
        }),
      },
      circuitBreaker: createCircuitBreaker({
        failureThreshold: 5,
        resetTimeoutMs: 60_000,
      }),
      semanticShadow: {
        schedule: (input) => {
          scheduledInput = input;
          return { scheduled: true };
        },
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
      uuid: () => 'req-shadow-1',
      now: () => 1000,
    });

    const result = await gateway.runDuplicateCheckGateway({
      title: 'Hello',
      content: 'World',
      language: 'en',
    });

    expect(result.contentHash).toBe('node-md5');
    expect(result.duplicateCheck.isDuplicate).toBe(expectedDc.isDuplicate);
    expect(result.duplicateCheck.score).toBe(expectedDc.score);
    expect(result.duplicateCheck.matchCount).toBe(expectedDc.matchCount);
    // No semantic fields leaked into user-facing duplicateCheck
    expect(result.duplicateCheck.semanticScore).toBeUndefined();
    expect(result.duplicateWarning).toBeUndefined();
    expect(scheduledInput).not.toBeNull();
    expect(scheduledInput.source).toBe('ai');
    expect(scheduledInput.aiNear.best_score).toBe(82);
  });
});
