'use strict';

/**
 * Candidate fetch for AI detect (Node-owned DB read).
 * Mirrors duplicateCheckService corpus windows without modifying that file.
 */

const CORPUS_DAYS = 3;
const PENDING_LIMIT = 100;

async function fetchAiCandidates(language, excludeId = null, deps = {}) {
  const News = deps.News || require('../../models/News');
  const lang = (language || 'te').toLowerCase();
  const since = new Date(Date.now() - CORPUS_DAYS * 24 * 60 * 60 * 1000);

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

  const [published, pending] = await Promise.all([
    News.find(publishedQuery).select(select).lean(),
    News.find(pendingQuery)
      .select(select)
      .sort({ publishedAt: -1 })
      .limit(PENDING_LIMIT)
      .lean(),
  ]);

  const rows = [...published, ...pending];
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
};
