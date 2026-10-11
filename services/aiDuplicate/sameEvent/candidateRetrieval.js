'use strict';

/**
 * Phase-0 Same-Event SHADOW — bounded candidate retrieval (READ-ONLY).
 *
 * Two sources, both indexed, bounded, capped, deduped. Rejected articles ARE
 * included (marked referenceOnly) but ONLY within the bounded historical
 * window. This NEVER scans the whole DB and NEVER writes anything.
 *
 *   Source A — Semantic/vector recall: recent same-language READY NewsVectors,
 *              joined to their News docs (rejected included).
 *   Source B — Structured recall: recent same-language News (rejected + no-embedding
 *              items included), so a prior same-event report is not missed just
 *              because it has no embedding yet or fell past the 100-pending cap.
 */

const C = require('../semantic/constants');

const SELECT =
  '_id title content author authorId location scope language publishedAt isActive rejectionStatus.isRejected contentHash';

function isRejected(doc) {
  return !!(doc && doc.rejectionStatus && doc.rejectionStatus.isRejected === true);
}

/** Source A — vectors (READY) + their News docs. Rejected included. */
async function fetchVectorCandidates(opts) {
  const { NewsVector, News, language, since, cap, embeddingVersion } = opts;
  const vecs = await NewsVector.find({
    status: C.STATUS.READY,
    language,
    embeddingVersion,
    publishedAt: { $gte: since },
  })
    .select('newsId embedding publishedAt')
    .sort({ publishedAt: -1 })
    .limit(cap)
    .lean();

  if (!vecs.length) return [];
  const ids = vecs.map((v) => v.newsId);
  const docs = await News.find({ _id: { $in: ids } })
    .select(SELECT)
    .lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  const out = [];
  for (const v of vecs) {
    const d = byId.get(String(v.newsId));
    if (!d || !Array.isArray(v.embedding) || !v.embedding.length) continue;
    out.push({
      newsId: String(d._id),
      title: d.title || '',
      content: d.content || '',
      author: d.author || null,
      authorId: d.authorId != null ? String(d.authorId) : null,
      location: d.location || null,
      scope: d.scope || null,
      language: d.language || language,
      publishedAt: v.publishedAt || d.publishedAt || null,
      isActive: d.isActive === true,
      referenceOnly: isRejected(d),
      embedding: v.embedding,
      source: 'vector',
    });
  }
  return out;
}

/** Source B — structured recent same-language News (rejected + no-embedding). */
async function fetchEventCandidates(opts) {
  const { News, language, since, cap } = opts;
  // Bounded: same-language, within window, capped, newest first. Rejected and
  // no-vector items are intentionally included here (that is the whole point).
  const docs = await News.find({
    language,
    publishedAt: { $gte: since },
  })
    .select(SELECT)
    .sort({ publishedAt: -1 })
    .limit(cap)
    .lean();

  return docs.map((d) => ({
    newsId: String(d._id),
    title: d.title || '',
    content: d.content || '',
    author: d.author || null,
    authorId: d.authorId != null ? String(d.authorId) : null,
    location: d.location || null,
    scope: d.scope || null,
    language: d.language || language,
    publishedAt: d.publishedAt || null,
    isActive: d.isActive === true,
    referenceOnly: isRejected(d),
    embedding: null, // may be filled from Source A on merge
    source: 'event',
  }));
}

/** Merge A∪B: dedupe by newsId (prefer the row that carries an embedding),
 *  drop self, cap total. Pure given its inputs. */
function mergeCandidates(vectorRows, eventRows, excludeId, maxTotal) {
  const byId = new Map();
  const put = (row) => {
    const id = String(row.newsId);
    if (excludeId && id === String(excludeId)) return;
    const ex = byId.get(id);
    if (!ex) {
      byId.set(id, row);
      return;
    }
    // Keep an embedding if either source has it; keep referenceOnly if either says so.
    ex.embedding = ex.embedding || row.embedding || null;
    ex.referenceOnly = ex.referenceOnly || row.referenceOnly;
    ex.source = ex.source === row.source ? ex.source : 'both';
  };
  vectorRows.forEach(put);
  eventRows.forEach(put);
  const merged = [...byId.values()];
  return merged.slice(0, maxTotal);
}

/**
 * Full retrieval. deps: { News, NewsVector }. cfg: flags object.
 * Returns { candidates, stats } — stats used for observability. READ-ONLY.
 */
async function retrieveCandidates(input, deps, cfg) {
  const News = deps.News || require('../../../models/News');
  const NewsVector = deps.NewsVector || require('../../../models/NewsVector');
  const language = String(input.language || 'te').toLowerCase();
  const since = new Date(Date.now() - cfg.windowDays * 24 * 3600 * 1000);
  const embeddingVersion = deps.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION;

  const [vectorRows, eventRows] = await Promise.all([
    fetchVectorCandidates({
      NewsVector, News, language, since, cap: cfg.maxVectorCandidates, embeddingVersion,
    }).catch(() => []),
    fetchEventCandidates({
      News, language, since, cap: cfg.maxEventCandidates,
    }).catch(() => []),
  ]);

  const candidates = mergeCandidates(
    vectorRows,
    eventRows,
    input.excludeId,
    cfg.maxTotalCandidates
  );

  const stats = {
    windowDays: cfg.windowDays,
    vectorCandidates: vectorRows.length,
    eventCandidates: eventRows.length,
    merged: candidates.length,
    rejectedReferences: candidates.filter((c) => c.referenceOnly).length,
    withEmbedding: candidates.filter((c) => Array.isArray(c.embedding) && c.embedding.length).length,
  };
  return { candidates, stats };
}

module.exports = {
  fetchVectorCandidates,
  fetchEventCandidates,
  mergeCandidates,
  retrieveCandidates,
  isRejected,
};
