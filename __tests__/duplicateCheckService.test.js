const {
  buildDuplicateCheckResult,
  normalizeDuplicateCheck
} = require('../services/duplicateCheckService');
const { generateContentHash } = require('../utils/similarityDetector');

describe('duplicateCheckService', () => {
  test('normalizeDuplicateCheck returns safe defaults', () => {
    expect(normalizeDuplicateCheck(null)).toEqual({
      isDuplicate: false,
      isSuspicious: false,
      score: 0,
      matchCount: 0,
      similarArticles: []
    });
  });

  test('buildDuplicateCheckResult marks exact match as duplicate', () => {
    const result = buildDuplicateCheckResult([], {
      _id: 'abc123',
      title: 'Test title',
      content: 'Test content',
      author: 'Reporter',
      category: 'News',
      location: 'Hyderabad',
      publishedAt: new Date('2026-01-01')
    });

    expect(result.isDuplicate).toBe(true);
    expect(result.score).toBe(100);
    expect(result.matchCount).toBe(1);
  });

  test('buildDuplicateCheckResult marks suspicious similar matches', () => {
    const result = buildDuplicateCheckResult([
      {
        articleId: 'published1',
        articleTitle: 'Similar title',
        similarity: { title: 70, content: 65, keywords: 50, overall: 64 },
        isDuplicate: false,
        isSuspicious: true
      }
    ]);

    expect(result.isSuspicious).toBe(true);
    expect(result.score).toBe(64);
    expect(result.matchCount).toBe(1);
  });

  test('run. hash is stable for same article text', () => {
    const hash1 = generateContentHash('Title', 'Content');
    const hash2 = generateContentHash('Title', 'Content');
    expect(hash1).toBe(hash2);
  });
});
