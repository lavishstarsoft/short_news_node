/**
 * Apply sub-editor/reporter displaySettings to public news author fields.
 */

function normalizeDisplaySettings(settings) {
  const s = settings || {};
  return {
    showProfileImage: s.showProfileImage !== false,
    showName: s.showName !== false,
    showConstituency: s.showConstituency !== false
  };
}

function resolveAuthorDisplayFields(newsItem, authorDoc) {
  const settings = normalizeDisplaySettings(authorDoc?.displaySettings);

  let authorProfileImage = newsItem.authorProfileImage || authorDoc?.profileImage || null;
  let authorConstituency = newsItem.authorConstituency || authorDoc?.constituency || null;
  let author = newsItem.author || authorDoc?.username || '';
  let authorName = authorDoc?.name || null;

  if (!settings.showProfileImage) authorProfileImage = null;
  if (!settings.showConstituency) authorConstituency = null;
  if (!settings.showName) {
    authorName = null;
    author = '';
  }

  return {
    author,
    authorName,
    authorProfileImage,
    authorConstituency,
    authorDisplaySettings: settings,
    authorRole: authorDoc?.role || 'editor'
  };
}

async function buildAuthorMap(Admin, authorIds) {
  const unique = [...new Set((authorIds || []).filter(Boolean).map(id => id.toString()))];
  if (!unique.length) return {};

  const authors = await Admin.find({ _id: { $in: unique } })
    .select('displaySettings profileImage constituency name username role')
    .lean();

  const map = {};
  authors.forEach((a) => {
    map[a._id.toString()] = a;
  });
  return map;
}

async function attachAuthorDisplayToNewsList(Admin, newsItems) {
  const list = Array.isArray(newsItems) ? newsItems : [];
  const authorMap = await buildAuthorMap(Admin, list.map((n) => n.authorId));

  return list.map((news) => {
    const authorDoc = news.authorId ? authorMap[news.authorId.toString()] : null;
    return resolveAuthorDisplayFields(news, authorDoc);
  });
}

module.exports = {
  normalizeDisplaySettings,
  resolveAuthorDisplayFields,
  buildAuthorMap,
  attachAuthorDisplayToNewsList
};
