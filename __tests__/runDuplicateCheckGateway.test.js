'use strict';

const {
  createGateway,
} = require('../services/aiDuplicate/runDuplicateCheckGateway');
const { createCircuitBreaker } = require('../services/aiDuplicate/circuitBreaker');
const { validateAiDetectResponse } = require('../services/aiDuplicate/validateAiResponse');
const { mapAiResponseToDuplicateCheck } = require('../services/aiDuplicate/mapAiToLegacy');

function validAiPayload(overrides = {}) {
  return {
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
    ...overrides,
  };
}

describe('runDuplicateCheckGateway', () => {
  const legacyResult = {
    contentHash: 'legacy-hash',
    duplicateCheck: {
      isDuplicate: false,
      isSuspicious: false,
      score: 0,
      matchCount: 0,
      checkedAt: new Date(),
      similarArticles: [],
    },
  };

  function build(env, httpClient, extras = {}) {
    const breaker = createCircuitBreaker({
      failureThreshold: extras.failureThreshold || 3,
      resetTimeoutMs: extras.resetTimeoutMs || 60_000,
      now: extras.now,
    });
    return createGateway({
      env,
      runDuplicateCheck: jest.fn().mockResolvedValue(legacyResult),
      fetchAiCandidates: jest.fn().mockResolvedValue([
        { id: 'c1', title: 'Hello', content: 'World' },
      ]),
      generateContentHash: jest.fn().mockReturnValue('node-md5'),
      httpClient,
      circuitBreaker: breaker,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      uuid: () => 'req-test-1',
      now: extras.now || (() => 1000),
    });
  }

  test('AI OFF uses legacy runDuplicateCheck only', async () => {
    const httpClient = { detectDuplicate: jest.fn() };
    const { runDuplicateCheckGateway } = build(
      { AI_DUPLICATE_ENABLED: 'false' },
      httpClient
    );
    const runLegacy = httpClient; // placeholder
    const gateway = build(
      { AI_DUPLICATE_ENABLED: 'false' },
      httpClient
    );
    const result = await gateway.runDuplicateCheckGateway(
      { title: 'T', content: 'C', language: 'en' },
      {}
    );
    expect(result).toEqual(legacyResult);
    expect(httpClient.detectDuplicate).not.toHaveBeenCalled();
  });

  test('AI success maps advisory to legacy shape', async () => {
    const httpClient = {
      detectDuplicate: jest.fn().mockResolvedValue({
        ok: true,
        source: 'ai',
        data: validAiPayload(),
      }),
    };
    const gateway = build(
      {
        AI_DUPLICATE_ENABLED: 'true',
        AI_SERVICE_URL: 'http://127.0.0.1:8000',
        AI_SERVICE_API_KEY: 'secret',
      },
      httpClient
    );
    const result = await gateway.runDuplicateCheckGateway(
      { title: 'Hello', content: 'World', language: 'en' },
      {}
    );
    expect(result.contentHash).toBe('node-md5');
    expect(result.duplicateCheck.isDuplicate).toBe(true);
    expect(result.duplicateCheck.score).toBe(82);
    expect(result.duplicateCheck.matchCount).toBe(1);
    expect(httpClient.detectDuplicate).toHaveBeenCalled();
  });

  test('Timeout falls back to legacy', async () => {
    const httpClient = {
      detectDuplicate: jest.fn().mockResolvedValue({
        ok: false,
        source: 'timeout',
        error: 'timeout',
      }),
    };
    const runLegacy = jest.fn().mockResolvedValue(legacyResult);
    const gateway = createGateway({
      env: { AI_DUPLICATE_ENABLED: 'true', AI_SERVICE_API_KEY: 'secret' },
      runDuplicateCheck: runLegacy,
      fetchAiCandidates: jest.fn().mockResolvedValue([]),
      generateContentHash: () => 'node-md5',
      httpClient,
      circuitBreaker: createCircuitBreaker({ failureThreshold: 99 }),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      uuid: () => 'req-timeout',
    });
    const result = await gateway.runDuplicateCheckGateway(
      { title: 'T', content: 'C', language: 'en' },
      {}
    );
    expect(result).toEqual(legacyResult);
    expect(runLegacy).toHaveBeenCalled();
  });

  test('Network error falls back to legacy', async () => {
    const httpClient = {
      detectDuplicate: jest.fn().mockResolvedValue({
        ok: false,
        source: 'error',
        error: 'ECONNREFUSED',
      }),
    };
    const runLegacy = jest.fn().mockResolvedValue(legacyResult);
    const gateway = createGateway({
      env: { AI_DUPLICATE_ENABLED: 'true', AI_SERVICE_API_KEY: 'secret' },
      runDuplicateCheck: runLegacy,
      fetchAiCandidates: jest.fn().mockResolvedValue([]),
      generateContentHash: () => 'node-md5',
      httpClient,
      circuitBreaker: createCircuitBreaker({ failureThreshold: 99 }),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      uuid: () => 'req-net',
    });
    const result = await gateway.runDuplicateCheckGateway(
      { title: 'T', content: 'C', language: 'en' },
      {}
    );
    expect(result).toEqual(legacyResult);
    expect(runLegacy).toHaveBeenCalled();
  });

  test('Invalid response falls back to legacy', async () => {
    const httpClient = {
      detectDuplicate: jest.fn().mockResolvedValue({
        ok: true,
        source: 'ai',
        data: { implemented: true, advisory: true },
      }),
    };
    const runLegacy = jest.fn().mockResolvedValue(legacyResult);
    const gateway = createGateway({
      env: { AI_DUPLICATE_ENABLED: 'true', AI_SERVICE_API_KEY: 'secret' },
      runDuplicateCheck: runLegacy,
      fetchAiCandidates: jest.fn().mockResolvedValue([]),
      generateContentHash: () => 'node-md5',
      httpClient,
      circuitBreaker: createCircuitBreaker({ failureThreshold: 99 }),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      uuid: () => 'req-invalid',
    });
    const result = await gateway.runDuplicateCheckGateway(
      { title: 'T', content: 'C', language: 'en' },
      {}
    );
    expect(result).toEqual(legacyResult);
    expect(runLegacy).toHaveBeenCalled();
  });

  test('Circuit breaker opens and skips AI', async () => {
    let t = 0;
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 10_000,
      now: () => t,
    });
    const httpClient = {
      detectDuplicate: jest.fn().mockResolvedValue({
        ok: false,
        source: 'error',
        error: '500',
      }),
    };
    const runLegacy = jest.fn().mockResolvedValue(legacyResult);
    const gateway = createGateway({
      env: { AI_DUPLICATE_ENABLED: 'true', AI_SERVICE_API_KEY: 'secret' },
      runDuplicateCheck: runLegacy,
      fetchAiCandidates: jest.fn().mockResolvedValue([]),
      generateContentHash: () => 'node-md5',
      httpClient,
      circuitBreaker: breaker,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      uuid: () => 'req-cb',
      now: () => t,
    });

    await gateway.runDuplicateCheckGateway({ title: 'T', content: 'C' }, {});
    await gateway.runDuplicateCheckGateway({ title: 'T', content: 'C' }, {});
    expect(breaker.getState()).toBe('open');

    httpClient.detectDuplicate.mockClear();
    await gateway.runDuplicateCheckGateway({ title: 'T', content: 'C' }, {});
    expect(httpClient.detectDuplicate).not.toHaveBeenCalled();
    expect(runLegacy).toHaveBeenCalled();
  });
});

describe('validateAiDetectResponse', () => {
  test('accepts frozen contract', () => {
    const result = validateAiDetectResponse(validAiPayload());
    expect(result.ok).toBe(true);
  });

  test('rejects missing overall', () => {
    const bad = validAiPayload();
    delete bad.overall;
    expect(validateAiDetectResponse(bad).ok).toBe(false);
  });
});

describe('mapAiResponseToDuplicateCheck', () => {
  test('maps very_similar to isDuplicate', () => {
    const mapped = mapAiResponseToDuplicateCheck(validAiPayload(), [
      { id: 'c1', title: 'Hello', content: 'World' },
    ]);
    expect(mapped.isDuplicate).toBe(true);
    expect(mapped.score).toBe(82);
    expect(mapped.similarArticles[0].articleTitle).toBe('Hello');
  });

  test('maps media duplicate when text does not match', () => {
    const payload = validAiPayload();
    payload.overall = {
      score: 10,
      label: 'unique',
      is_duplicate: false,
      is_suspicious: false,
    };
    payload.exact = { matched: false, score: 0, matched_candidate_id: null };
    payload.near = { matched: false, best_score: 0, matches: [] };
    payload.media = {
      duplicate: true,
      method: 'bytes',
      similarity: 100,
      matchedNewsId: 'c1',
      query_sha256: 'abc',
    };
    const mapped = mapAiResponseToDuplicateCheck(payload, [
      { id: 'c1', title: 'Other', content: 'Different' },
    ]);
    expect(mapped.isDuplicate).toBe(true);
    expect(mapped.score).toBe(100);
    expect(mapped.mediaPassAt).toBeTruthy();
    expect(mapped.matchSource).toBe('image');
    expect(mapped.reasonLabel).toBe('Image');
    expect(mapped.similarArticles[0].articleId).toBe('c1');
    expect(mapped.similarArticles[0].matchSource).toBe('image');
  });

  test('maps content near match as content source', () => {
    const mapped = mapAiResponseToDuplicateCheck(validAiPayload(), [
      { id: 'c1', title: 'Hello', content: 'World' },
    ]);
    expect(mapped.matchSource).toBe('content');
    expect(mapped.reasonLabel).toBe('Content');
  });
});
