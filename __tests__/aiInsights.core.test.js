'use strict';

const {
  cosineSimilarity,
  scoreToPercent,
  createUnionFind,
  buildWindowedEdges,
  clusterFromEdges,
  buildGroupDraft,
} = require('../services/aiInsights');
const { formatTimeDiffLabel, pickOriginalMember } = require('../services/aiInsights/timeFormat');

describe('AI Insights core', () => {
  test('cosine similarity identical vectors = 1', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
  });

  test('scoreToPercent clamps', () => {
    expect(scoreToPercent(0.965)).toBe(96.5);
    expect(scoreToPercent(2)).toBe(100);
  });

  test('union-find clusters edges', () => {
    const uf = createUnionFind(['a', 'b', 'c', 'd']);
    uf.union('a', 'b');
    uf.union('c', 'd');
    const comps = uf.components().map((c) => c.sort().join(','));
    expect(comps).toContain('a,b');
    expect(comps).toContain('c,d');
  });

  test('windowed edges respect time window and threshold', () => {
    const base = Date.parse('2026-02-11T10:00:00.000Z');
    const embA = [1, 0, 0, 0];
    const embB = [0.99, 0.1, 0, 0];
    const embC = [0, 1, 0, 0];
    const articles = [
      { newsId: '1', publishedAt: new Date(base), embedding: embA },
      { newsId: '2', publishedAt: new Date(base + 2 * 60 * 1000), embedding: embB },
      { newsId: '3', publishedAt: new Date(base + 5 * 24 * 3600 * 1000), embedding: embA },
    ];
    const { edges } = buildWindowedEdges(articles, {
      minSimilarity: 0.5,
      compareWindowHours: 1,
    });
    const ids = edges.map((e) => [e.a, e.b].sort().join('-'));
    expect(ids).toContain('1-2');
    expect(ids).not.toContain('1-3');
  });

  test('original is earliest publisher with time diffs', () => {
    const base = Date.parse('2026-02-11T04:45:21.000Z');
    const articles = [
      {
        newsId: 'b',
        publishedAt: new Date(base + 148000),
        embedding: [1, 0],
        headline: 'Later',
        language: 'te',
        reporterName: 'R2',
      },
      {
        newsId: 'a',
        publishedAt: new Date(base),
        embedding: [1, 0],
        headline: 'First',
        language: 'te',
        reporterName: 'R1',
      },
    ];
    const articleById = new Map(articles.map((a) => [String(a.newsId), a]));
    const { edges } = buildWindowedEdges(articles, {
      minSimilarity: 0.9,
      compareWindowHours: 24,
    });
    const { components, pairScores } = clusterFromEdges(
      articles.map((a) => String(a.newsId)),
      edges
    );
    expect(components.length).toBe(1);
    const draft = buildGroupDraft(components[0], articleById, pairScores);
    expect(String(draft.originalNewsId)).toBe('a');
    expect(draft.members[0].role).toBe('original');
    expect(draft.members[1].role).toBe('similar');
    expect(draft.members[1].timeDiffLabel).toBe(formatTimeDiffLabel(148000));
    expect(pickOriginalMember(articles).newsId).toBe('a');
  });
});
