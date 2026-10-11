'use strict';

const {
  cosine,
  factTokens,
  buildIdf,
  factOverlap,
  verdictFor,
  loadThresholds,
  isDecisiveFor,
  mergeRowsIntoDuplicateCheck,
  createSemanticDecisionService,
} = require('../services/aiDuplicate/semantic/semanticDecisionService');

const T = loadThresholds({});

function unit(seed, dims = 384) {
  // deterministic pseudo-random unit vector
  let x = seed;
  const v = Array.from({ length: dims }, () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280 - 0.5;
  });
  const n = Math.sqrt(v.reduce((p, c) => p + c * c, 0));
  return v.map((c) => c / n);
}
function mix(a, b, w) {
  const v = a.map((c, i) => c * (1 - w) + b[i] * w);
  const n = Math.sqrt(v.reduce((p, c) => p + c * c, 0));
  return v.map((c) => c / n);
}

describe('semantic decision — math', () => {
  test('cosine identical = 1, orthogonal-ish random ≈ 0', () => {
    const a = unit(1);
    expect(cosine(a, a)).toBeCloseTo(1, 6);
    expect(Math.abs(cosine(unit(1), unit(2)))).toBeLessThan(0.2);
  });

  test('factTokens keeps numbers and words, drops short/digit-only words', () => {
    const s = factTokens('Rupee falls to 94.95 vs dollar', 'RBI said 2 things about H-1B');
    expect(s.has('#9495')).toBe(true);
    expect(s.has('rupee')).toBe(true);
    expect([...s].some((t) => t === '2')).toBe(false);
  });

  test('factOverlap: shared rare facts score high, shared common words score low', () => {
    const corpus = [
      factTokens('government meeting held in district', 'district collector said government works'),
      factTokens('government announces district scheme', 'district officials government'),
      factTokens('Sydney flights hit by air traffic staff shortage', 'Airservices Australia 60 cancellations'),
      factTokens('Cape Town flights diverted after runway closure', 'airports company south africa'),
    ];
    const idf = buildIdf(corpus);
    // two "government/district" articles share only common words → low
    expect(factOverlap(corpus[0], corpus[1], idf)).toBeLessThan(0.7);
    // Sydney vs Cape Town: same topic, different facts → low
    expect(factOverlap(corpus[2], corpus[3], idf)).toBeLessThan(0.3);
    // a rewrite of the Sydney story sharing the specific facts → high
    const rewrite = factTokens('Staff shortage disrupts Sydney flights', 'Airservices Australia confirms 60 cancellations');
    expect(factOverlap(corpus[2], rewrite, idf)).toBeGreaterThan(0.4);
  });
});

describe('semantic decision — verdict thresholds (calibrated)', () => {
  test.each([
    [0.96, 0.0, 'duplicate'], // near-verbatim paraphrase
    [0.93, 0.5, 'duplicate'],
    [0.93, 0.35, 'suspicious'],
    [0.91, 0.5, 'suspicious'],
    [0.91, 0.2, null], // same topic, different event (Sydney/Cape Town zone)
    [0.87, 0.9, null], // meaning too weak
    [0.93, 0.1, null],
  ])('sem=%p fact=%p → %p', (sem, fact, expected) => {
    expect(verdictFor(sem, fact, T)).toBe(expected);
  });
});

describe('semantic decision — template veto (daily updates are not copies)', () => {
  const { numberOverlap, applyTemplateVeto } = require('../services/aiDuplicate/semantic/semanticDecisionService');
  test('disjoint numbers, same author → no match; different author → capped at suspicious', () => {
    const a = factTokens('Rupee slips to 95.79 against dollar', '');
    const b = factTokens('Rupee falls to 94.95 against dollar', '');
    expect(numberOverlap(a, b)).toBe(0);
    expect(applyTemplateVeto('duplicate', 0, true)).toBe(null);
    expect(applyTemplateVeto('duplicate', 0, false)).toBe('suspicious');
  });
  test('shared numbers keep the verdict; no numbers → veto does not apply', () => {
    const a = factTokens('Trade show from 25 September in Greater Noida', '');
    const b = factTokens('UP International Trade Show starts 25 September', '');
    expect(numberOverlap(a, b)).toBeGreaterThan(0);
    expect(applyTemplateVeto('duplicate', numberOverlap(a, b), true)).toBe('duplicate');
    expect(numberOverlap(factTokens('no digits here', ''), b)).toBe(null);
    expect(applyTemplateVeto('duplicate', null, true)).toBe('duplicate');
  });
});

describe('semantic decision — flags', () => {
  test('OFF by default; language gating', () => {
    expect(isDecisiveFor('te', {})).toBe(false);
    expect(isDecisiveFor('te', { AI_SEMANTIC_DECISIVE: 'true' })).toBe(true);
    expect(isDecisiveFor('hi', { AI_SEMANTIC_DECISIVE: 'true', AI_SEMANTIC_DECISIVE_LANGS: 'te,en' })).toBe(false);
    expect(isDecisiveFor('en', { AI_SEMANTIC_DECISIVE: 'true', AI_SEMANTIC_DECISIVE_LANGS: 'te,en' })).toBe(true);
  });
});

describe('semantic decision — merge', () => {
  test('adds rows and raises top-level flags; never clears existing', () => {
    const base = { isDuplicate: false, isSuspicious: false, score: 0, matchCount: 0, similarArticles: [] };
    const row = {
      articleId: 'B', similarity: { title: 0, content: 96, keywords: 60, overall: 96 },
      isDuplicate: true, isSuspicious: false, matchSource: 'content', matchType: 'semantic',
      reasonLabel: 'Meaning + shared facts', reasonMessage: 'x',
    };
    const out = mergeRowsIntoDuplicateCheck(base, [row]);
    expect(out.isDuplicate).toBe(true);
    expect(out.matchCount).toBe(1);
    expect(out.score).toBe(96);
    expect(out.matchSource).toBe('content');
    expect(out.reasonLabel).toBe('Meaning + shared facts');
  });

  test('image row + semantic row for the same article → both', () => {
    const base = {
      isDuplicate: false, isSuspicious: false, score: 0, matchCount: 1, matchSource: 'image',
      similarArticles: [{ articleId: 'B', matchSource: 'image', matchType: 'ann', similarity: { title: 0, content: 0, keywords: 0, overall: 86 }, isDuplicate: false, isSuspicious: false }],
    };
    const row = { articleId: 'B', similarity: { title: 0, content: 94, keywords: 55, overall: 94 }, isDuplicate: true, isSuspicious: false, matchSource: 'content', matchType: 'semantic', reasonLabel: 'Meaning + shared facts', reasonMessage: 'x' };
    const out = mergeRowsIntoDuplicateCheck(base, [row]);
    expect(out.similarArticles[0].matchSource).toBe('both');
    expect(out.isDuplicate).toBe(true);
    expect(out.matchSource).toBe('both');
  });

  test('no rows → unchanged', () => {
    const base = { isDuplicate: false, similarArticles: [] };
    expect(mergeRowsIntoDuplicateCheck(base, [])).toEqual(base);
  });
});

describe('semantic decision — service (mocked deps, no DB)', () => {
  const A = unit(11);
  const rewrite = mix(A, unit(12), 0.08); // very close meaning
  const topicOnly = mix(A, unit(13), 0.28); // same topic, different facts
  const env = { AI_SEMANTIC_DECISIVE: 'true', AI_EXACT_GUARD: 'true' };
  const nowMs = Date.parse('2026-09-11T10:00:00Z');

  function svc(overrides = {}) {
    return createSemanticDecisionService({
      env,
      now: () => nowMs,
      embedText: async () => ({ ok: true, embedding: A, latencyMs: 1 }),
      loaders: {
        loadWindowVectors: async () => [
          { newsId: 'R', embedding: rewrite, publishedAt: new Date(nowMs - 3600e3), isActive: true },
          { newsId: 'T', embedding: topicOnly, publishedAt: new Date(nowMs - 7200e3), isActive: true },
          { newsId: 'SELF', embedding: A, publishedAt: new Date(nowMs - 10e3), isActive: false },
        ],
        loadNewsTexts: async () => [
          { _id: 'R', title: 'Staff shortage disrupts Sydney flights', content: 'Airservices Australia confirms 60 cancellations at Sydney Airport', isActive: true },
          { _id: 'T', title: 'Cape Town flights diverted after runway closure', content: 'Airports Company South Africa confirmed the closure', isActive: true },
          { _id: 'SELF', title: 'Sydney Flights Hit by Air Traffic Staff Shortage', content: 'Airservices Australia 60 cancellations', isActive: false },
        ],
        findExactHash: async (hash) => (hash === 'HASH-DUP' ? { _id: 'X', title: 'same', content: 'same', isActive: true, publishedAt: new Date(nowMs - 60e3) } : null),
      },
      ...overrides,
    });
  }

  const query = { title: 'Sydney Flights Hit by Air Traffic Staff Shortage', content: 'Airservices Australia 60 cancellations', language: 'en', excludeId: 'SELF' };

  test('flags the rewrite (meaning+facts), not the same-topic story, and never itself', async () => {
    const r = await svc().evaluate(query);
    expect(r.ok).toBe(true);
    const ids = r.rows.map((x) => x.articleId);
    expect(ids).toContain('R');
    expect(ids).not.toContain('T');
    expect(ids).not.toContain('SELF');
    const row = r.rows.find((x) => x.articleId === 'R');
    expect(row.matchType).toBe('semantic');
    expect(row.similarity.content).toBeGreaterThanOrEqual(92);
    expect(row.isDuplicate || row.isSuspicious).toBe(true);
  });

  test('disabled flag → no-op', async () => {
    const r = await svc({ env: {} }).evaluate(query);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('disabled');
  });

  test('embed failure → clean, never throws', async () => {
    const r = await svc({ embedText: async () => ({ ok: false, error: 'embed_http_500' }) }).evaluate(query);
    expect(r.ok).toBe(false);
    expect(r.rows).toEqual([]);
  });

  test('exact guard adds an Exact copy row; applyLayers merges both layers', async () => {
    const s = svc();
    const dc = await s.applyLayers({ isDuplicate: false, isSuspicious: false, score: 0, matchCount: 0, similarArticles: [] }, { ...query, contentHash: 'HASH-DUP', requestId: 'r1' });
    expect(dc.isDuplicate).toBe(true);
    const types = dc.similarArticles.map((x) => x.matchType).sort();
    expect(types).toContain('text_exact');
    expect(types).toContain('semantic');
    expect(dc.score).toBe(100);
  });

  test('window is cached within CACHE_MS', async () => {
    let calls = 0;
    const s = svc({ loaders: { loadWindowVectors: async () => { calls += 1; return []; }, loadNewsTexts: async () => [], findExactHash: async () => null } });
    await s.evaluate(query);
    await s.evaluate(query);
    expect(calls).toBe(1);
  });
});
