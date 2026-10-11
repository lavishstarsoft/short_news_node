'use strict';

/**
 * Candidate fetch for AI detect (Node-owned DB read).
 * Mirrors duplicateCheckService corpus windows without modifying that file.
 */

// Env-driven so the window can be tuned without a deploy. Defaults: 3-day
// corpus, 100 recent pending. Exact-hash matching stays unlimited elsewhere,
// so an exact copy of an older story is still caught regardless of this window.
const CORPUS_DAYS = (() => {
  const n = parseInt(process.env.DUP_CORPUS_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
})();
const PENDING_LIMIT = 100;
// Hard cap on candidates sent to the AI /v1/detect (keeps payload/cost bounded
// as the window grows). Same-location + most-recent are prioritised before the
// cap so nearby duplicates are never dropped; cross-location matches within the
// cap still flow through (legitimate same-event-different-place is NOT blocked).
const MAX_DETECT_CANDIDATES = (() => {
  const n = parseInt(process.env.AI_MAX_DETECT_CANDIDATES, 10);
  return Number.isFinite(n) && n > 0 ? n : 800;
})();

async function fetchAiCandidates(language, excludeId = null, deps = {}) {
  const News = deps.News || require('../../models/News');
  const lang = (language || 'te').toLowerCase();
  const since = new Date(Date.now() - CORPUS_DAYS * 24 * 60 * 60 * 1000);
  const location = deps.location || null;

  const publishedQuery = {
    isActive: true,
    publishedAt: { $gte: since },
    language: lang,
  };
  const pendingQuery = {
    isActive: false,
    language: lang,
    $or: [
      { 'rejectionStatus.isRejected': { $ne: true } },
      { rejectionStatus: { $exists: false } },
    ],
  };

  if (excludeId) {
    publishedQuery._id = { $ne: excludeId };
    pendingQuery._id = { $ne: excludeId };
  }

  const select =
    '_id title content publishedAt author category location language isActive mediaUrl mediaType imageUrls thumbnailUrl videoUrl mediaFingerprint';

  // Same-location published news is fetched in its OWN bounded query so local
  // duplicates anywhere in the window are kept, while the main query is capped
  // AT THE DATABASE. Previously the published query had no limit, so a busy
  // language (thousands/day) pulled the WHOLE window into memory just to trim
  // it to the cap — that was the 3-5 s cost. We only ever send
  // MAX_DETECT_CANDIDATES to the AI, so fetching more was pure waste.
  const nearQuery = location ? { ...publishedQuery, location } : null;

  const [recent, near, pending] = await Promise.all([
    News.find(publishedQuery).select(select).sort({ publishedAt: -1 }).limit(MAX_DETECT_CANDIDATES).lean(),
    nearQuery
      ? News.find(nearQuery).select(select).sort({ publishedAt: -1 }).limit(MAX_DETECT_CANDIDATES).lean()
      : Promise.resolve([]),
    News.find(pendingQuery).select(select).sort({ publishedAt: -1 }).limit(PENDING_LIMIT).lean(),
  ]);

  // Merge: same-location first (most duplicates are local), then recent, then
  // pending; de-dupe by id, then cap for the AI payload.
  const seen = new Set();
  let rows = [];
  for (const r of [...near, ...recent, ...pending]) {
    const id = String(r._id);
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push(r);
  }
  if (rows.length > MAX_DETECT_CANDIDATES) rows = rows.slice(0, MAX_DETECT_CANDIDATES);

  return rows.map((row) => {
    const fp = row.mediaFingerprint || {};
    const clip =
      Array.isArray(fp.clipEmbedding) && fp.clipEmbedding.length
        ? fp.clipEmbedding
        : undefined;
    return {
      id: String(row._id),
      title: row.title || '',
      content: row.content || '',
      language: row.language || lang,
      is_active: row.isActive === true,
      publishedAt: row.publishedAt,
      author: row.author,
      category: row.category,
      location: row.location,
      media_url: row.mediaUrl || '',
      media_type: row.mediaType || '',
      image_urls: Array.isArray(row.imageUrls) ? row.imageUrls.filter(Boolean) : [],
      thumbnail_url: row.thumbnailUrl || '',
      video_url: row.videoUrl || '',
      phash: fp.phash || undefined,
      dhash: fp.dhash || undefined,
      sha256: fp.sha256 || undefined,
      clip_embedding: clip,
      media_fingerprint: {
        status: fp.status || undefined,
        sha256: fp.sha256 || undefined,
        phash: fp.phash || undefined,
        dhash: fp.dhash || undefined,
        clipEmbedding: clip,
        clipEmbeddingVersion: fp.clipEmbeddingVersion || undefined,
      },
    };
  });
}

module.exports = {
  fetchAiCandidates,
  CORPUS_DAYS,
  PENDING_LIMIT,
  MAX_DETECT_CANDIDATES,
};
