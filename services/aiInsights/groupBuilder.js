'use strict';

const { cosineSimilarity, scoreToPercent } = require('./cosine');
const { createUnionFind } = require('./unionFind');
const {
  formatTimeDiffLabel,
  pickOriginalMember,
} = require('./timeFormat');
const C = require('./constants');

/**
 * Build undirected similarity edges using a sliding publish-time window.
 * Complexity ~ O(n * w) where w = articles in window — not O(n²).
 */
function buildWindowedEdges(articles, options = {}) {
  const minSimilarity = options.minSimilarity ?? C.DEFAULT_MIN_SIMILARITY;
  const windowMs =
    (options.compareWindowHours ?? C.DEFAULT_COMPARE_WINDOW_HOURS) * 3600 * 1000;

  const sorted = [...articles].sort(
    (a, b) => new Date(a.publishedAt) - new Date(b.publishedAt)
  );

  const edges = [];
  let comparisons = 0;

  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i];
    const tA = new Date(a.publishedAt).getTime();
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j];
      const tB = new Date(b.publishedAt).getTime();
      if (tB - tA > windowMs) break;
      comparisons += 1;
      const score = cosineSimilarity(a.embedding, b.embedding);
      if (score >= minSimilarity) {
        edges.push({
          a: String(a.newsId),
          b: String(b.newsId),
          score,
        });
      }
    }
  }

  return { edges, comparisons };
}

/**
 * Merge edge list into clusters via union-find.
 * Pair scores map key: sortedIdPair
 */
function clusterFromEdges(newsIds, edges) {
  const uf = createUnionFind(newsIds);
  const pairScores = new Map();

  for (const edge of edges) {
    const a = String(edge.a);
    const b = String(edge.b);
    uf.union(a, b);
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const prev = pairScores.get(key);
    if (prev == null || edge.score > prev) {
      pairScores.set(key, edge.score);
    }
  }

  const components = uf
    .components()
    .filter((c) => c.length >= 2)
    .map((c) => c.sort());

  return { components, pairScores };
}

function pairScore(pairScores, idA, idB) {
  const a = String(idA);
  const b = String(idB);
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  return pairScores.get(key) ?? 0;
}

/**
 * Turn a component of newsIds into a group draft using article meta map.
 */
function buildGroupDraft(componentIds, articleById, pairScores) {
  const membersRaw = componentIds
    .map((id) => articleById.get(String(id)))
    .filter(Boolean);

  if (membersRaw.length < 2) return null;

  const originalMeta = pickOriginalMember(membersRaw);
  if (!originalMeta) return null;

  const originalId = String(originalMeta.newsId);
  const originalAt = new Date(originalMeta.publishedAt).getTime();

  const members = membersRaw
    .map((m) => {
      const id = String(m.newsId);
      const publishedAt = new Date(m.publishedAt);
      const isOriginal = id === originalId;
      const score = isOriginal
        ? 1
        : pairScore(pairScores, originalId, id) ||
          // fallback: best edge score to any earlier member
          Math.max(
            0,
            ...membersRaw
              .filter((o) => String(o.newsId) !== id)
              .map((o) => pairScore(pairScores, id, o.newsId))
          );
      const diffMs = Math.max(0, publishedAt.getTime() - originalAt);
      return {
        newsId: m.newsId,
        role: isOriginal ? C.MEMBER_ROLE.ORIGINAL : C.MEMBER_ROLE.SIMILAR,
        headline: m.headline || '',
        reporterName: m.reporterName || null,
        reporterId: m.reporterId || null,
        subEditorName: m.subEditorName || null,
        subEditorId: m.subEditorId || null,
        publishedAt,
        language: m.language || 'te',
        similarityToOriginal: isOriginal ? 1 : score,
        similarityPercent: isOriginal ? 100 : scoreToPercent(score),
        timeDiffMsFromOriginal: isOriginal ? 0 : diffMs,
        timeDiffLabel: isOriginal ? '+00:00:00' : formatTimeDiffLabel(diffMs),
      };
    })
    .sort((a, b) => {
      if (a.role !== b.role) {
        return a.role === C.MEMBER_ROLE.ORIGINAL ? -1 : 1;
      }
      return new Date(a.publishedAt) - new Date(b.publishedAt);
    });

  const similars = members.filter((m) => m.role === C.MEMBER_ROLE.SIMILAR);
  const scores = similars.map((m) => m.similarityToOriginal);
  const highest = scores.length ? Math.max(...scores) : 0;
  const average = scores.length
    ? scores.reduce((s, v) => s + v, 0) / scores.length
    : 0;
  const firstPublishedAt = members[0].publishedAt;
  const lastPublishedAt = members.reduce(
    (max, m) => (m.publishedAt > max ? m.publishedAt : max),
    members[0].publishedAt
  );

  return {
    language: originalMeta.language || 'te',
    originalNewsId: originalMeta.newsId,
    members,
    similarCount: similars.length,
    highestSimilarity: highest,
    highestSimilarityPercent: scoreToPercent(highest),
    averageSimilarity: average,
    averageSimilarityPercent: scoreToPercent(average),
    firstPublishedAt,
    lastPublishedAt,
    spanMs: Math.max(0, lastPublishedAt - firstPublishedAt),
    memberNewsIds: members.map((m) => m.newsId),
    advisoryNote: C.ADVISORY_DISCLAIMER,
  };
}

module.exports = {
  buildWindowedEdges,
  clusterFromEdges,
  buildGroupDraft,
  pairScore,
};
