'use strict';

const { createReporterDuplicateController } = require('../controllers/reporterDuplicateController');

const ID_A = '65a0000000000000000000a1';
const ID_B = '65a0000000000000000000b2';

function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}
const req = (body, id = 'rep1') => ({ admin: { id }, body });

const flaggedResult = {
  duplicateCheck: {
    isDuplicate: false,
    isSuspicious: true,
    score: 72,
    reasonLabel: 'Content',
    similarArticles: [
      { articleId: ID_A, articleTitle: 'Ganesh idol 17 ft', content: 'Body A', author: 'ravi', isActive: true, publishStatus: 'published', similarity: { overall: 72 }, thumbnailUrl: 'https://cdn/a.jpg' },
      { articleId: ID_B, articleTitle: 'Rejected one', content: 'Body B', publishStatus: 'rejected', similarity: { overall: 60 } },
      { articleId: ID_A, articleTitle: 'Ganesh idol 17 ft', content: 'Body A', publishStatus: 'published', similarity: { overall: 40 } }, // dup id, lower score
    ],
  },
};

function build(overrides = {}) {
  return createReporterDuplicateController({
    runDuplicateCheckGateway: overrides.gateway || (async () => flaggedResult),
    enrichSimilarArticlesFromDb: overrides.enrich || (async (rows) => rows),
    Admin: { findById: () => ({ select: () => ({ lean: async () => ({ workingLanguage: 'te' }) }) }) },
    env: { REPORTER_DUP_TIMEOUT_MS: overrides.timeoutMs || '4000', ...(overrides.env || {}) },
    now: overrides.now,
  });
}

describe('reporter pre-submit similar-news check', () => {
  test('flagged result → found:true with clean, de-duplicated, rejected-free cards', async () => {
    const c = build();
    const res = mockRes();
    await c.similarNews(req({ title: 'దెందుకూరులో 17 అడుగుల గణనాథుడు', content: 'మధిర మండలంలో…' }), res);
    const b = res.body;
    expect(b.success).toBe(true);
    expect(b.checked).toBe(true);
    expect(b.found).toBe(true);
    expect(b.isSuspicious).toBe(true);
    expect(b.matches).toHaveLength(1); // rejected dropped, duplicate id merged
    expect(b.matches[0]).toMatchObject({ id: ID_A, title: 'Ganesh idol 17 ft', status: 'published', score: 72, imageUrl: 'https://cdn/a.jpg', author: 'ravi' });
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  test('engine says clean → found:false, no cards', async () => {
    const c = build({ gateway: async () => ({ duplicateCheck: { isDuplicate: false, isSuspicious: false, score: 5, similarArticles: [] } }) });
    const res = mockRes();
    await c.similarNews(req({ title: 'Fresh unique headline here', content: 'Totally new content' }), res);
    expect(res.body.found).toBe(false);
    expect(res.body.checked).toBe(true);
    expect(res.body.matches).toEqual([]);
  });

  test('a slow engine never blocks the reporter: timeout → checked:false', async () => {
    const c = build({ gateway: () => new Promise(() => {}), timeoutMs: '15' });
    const res = mockRes();
    await c.similarNews(req({ title: 'Some headline long enough', content: 'and content' }), res);
    expect(res.body.checked).toBe(false);
    expect(res.body.found).toBe(false);
  });

  test('too little text → instant clean answer, engine not called', async () => {
    const gateway = jest.fn(async () => flaggedResult);
    const c = build({ gateway });
    const res = mockRes();
    await c.similarNews(req({ title: 'hi', content: '' }), res);
    expect(gateway).not.toHaveBeenCalled();
    expect(res.body.found).toBe(false);
  });

  test('same text again within TTL is served from cache (pre-warm → instant submit)', async () => {
    const gateway = jest.fn(async () => flaggedResult);
    const c = build({ gateway });
    const body = { title: 'Same headline again and again', content: 'same content' };
    const r1 = mockRes();
    await c.similarNews(req(body), r1);
    const r2 = mockRes();
    await c.similarNews(req(body), r2);
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(r2.body.cached).toBe(true);
    expect(r2.body.found).toBe(true);
  });

  test('cache is per reporter + text (different reporter → fresh run)', async () => {
    const gateway = jest.fn(async () => flaggedResult);
    const c = build({ gateway });
    const body = { title: 'Same headline again and again', content: 'same content' };
    await c.similarNews(req(body, 'rep1'), mockRes());
    await c.similarNews(req(body, 'rep2'), mockRes());
    expect(gateway).toHaveBeenCalledTimes(2);
  });

  test('no auth → 401', async () => {
    const c = build();
    const res = mockRes();
    await c.similarNews({ admin: null, body: { title: 'x'.repeat(20) } }, res);
    expect(res.statusCode).toBe(401);
  });

  test('gateway throws → treated as unchecked (never 500 for the reporter)', async () => {
    const c = build({ gateway: async () => { throw new Error('boom'); } });
    const res = mockRes();
    await c.similarNews(req({ title: 'Headline that is long enough', content: 'content' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.checked).toBe(false);
  });
});
