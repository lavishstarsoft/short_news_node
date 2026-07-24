'use strict';

/**
 * Fill empty title/content/author on similarArticles from Mongo.
 * Image/ANN matches often return a newsId that was not in the language-scoped
 * candidate list, so mapAiToLegacy stores blank metadata.
 */

const mongoose = require('mongoose');

function resolveNewsId(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object' && raw._id) {
    return resolveNewsId(raw._id);
  }
  const s = String(raw).trim();
  if (!s) return null;
  // Fingerprint media_id: `${newsId}:${url}`
  const colon = s.indexOf(':');
  if (colon > 0) {
    const head = s.slice(0, colon);
    if (mongoose.Types.ObjectId.isValid(head)) return head;
  }
  return s;
}

async function enrichSimilarArticlesFromDb(similarArticles, deps = {}) {
  const News = deps.News || require('../../models/News');
  const list = Array.isArray(similarArticles) ? similarArticles : [];
  if (!list.length) return list;

  const ids = [];
  const seen = new Set();
  for (const row of list) {
    const id = resolveNewsId(row && row.articleId);
    if (!id || !mongoose.Types.ObjectId.isValid(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) return list;

  const docs = await News.find({ _id: { $in: ids } })
    .select(
      '_id title content author category location publishedAt isActive mediaUrl mediaType thumbnailUrl language'
    )
    .lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  return list.map((row) => {
    const id = resolveNewsId(row && row.articleId);
    const doc = id ? byId.get(String(id)) : null;
    if (!doc) {
      return {
        ...row,
        articleId: id || row.articleId,
      };
    }
    const needsTitle = !row.articleTitle || !String(row.articleTitle).trim();
    const needsContent = !row.content || !String(row.content).trim();
    return {
      ...row,
      articleId: String(doc._id),
      articleTitle: needsTitle ? doc.title || '' : row.articleTitle,
      content: needsContent ? doc.content || '' : row.content,
      author: row.author || doc.author || null,
      category: row.category || doc.category || null,
      location: row.location || doc.location || null,
      publishedAt: row.publishedAt || doc.publishedAt || null,
      isActive: typeof row.isActive === 'boolean' ? row.isActive : doc.isActive === true,
      language: row.language || doc.language || null,
      mediaUrl: row.mediaUrl || doc.mediaUrl || doc.thumbnailUrl || null,
      mediaType: row.mediaType || doc.mediaType || null,
      thumbnailUrl: row.thumbnailUrl || doc.thumbnailUrl || doc.mediaUrl || null,
    };
  });
}

module.exports = {
  resolveNewsId,
  enrichSimilarArticlesFromDb,
};
