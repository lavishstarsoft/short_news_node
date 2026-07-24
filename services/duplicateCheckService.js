const News = require('../models/News');
const { checkDuplicateFast, generateContentHash } = require('../utils/similarityDetector');

const CORPUS_DAYS = 3;
const MIN_MATCH_SCORE = 50;

function normalizeDuplicateCheck(raw) {
  if (!raw) {
    return {
      isDuplicate: false,
      isSuspicious: false,
      score: 0,
      matchCount: 0,
      mediaPassAt: null,
      matchSource: null,
      reasonLabel: null,
      reasonMessage: null,
      similarArticles: []
    };
  }

  const similarArticles = Array.isArray(raw.similarArticles) ? raw.similarArticles : [];

  return {
    isDuplicate: raw.isDuplicate === true,
    isSuspicious: raw.isSuspicious === true,
    score: typeof raw.score === 'number' ? raw.score : 0,
    matchCount: typeof raw.matchCount === 'number' ? raw.matchCount : similarArticles.length,
    checkedAt: raw.checkedAt || null,
    // Set when AI media cascade successfully hashed the query image.
    // Pending lazy-check uses this to retry stale false-negatives (e.g. download_failed).
    mediaPassAt: raw.mediaPassAt || null,
    matchSource: raw.matchSource || null,
    reasonLabel: raw.reasonLabel || null,
    reasonMessage: raw.reasonMessage || null,
    similarArticles
  };
}

function buildExactMatchEntry(exactMatch) {
  return {
    articleId: exactMatch._id,
    articleTitle: exactMatch.title,
    content: exactMatch.content || '',
    publishedAt: exactMatch.publishedAt,
    author: exactMatch.author,
    category: exactMatch.category,
    location: exactMatch.location,
    similarity: {
      title: 100,
      content: 100,
      keywords: 100,
      overall: 100
    },
    isDuplicate: true,
    isSuspicious: false,
    matchSource: 'content',
    matchType: 'text_exact',
    reasonLabel: 'Content'
  };
}

function buildDuplicateCheckResult(duplicateResults, exactMatch = null) {
  if (exactMatch) {
    const entry = buildExactMatchEntry(exactMatch);
    return {
      isDuplicate: true,
      isSuspicious: false,
      score: 100,
      matchCount: 1,
      checkedAt: new Date(),
      matchSource: 'content',
      reasonLabel: 'Content',
      reasonMessage: 'Similar title or text content detected.',
      similarArticles: [entry]
    };
  }

  const topMatches = duplicateResults
    .filter(result => result.similarity.overall >= MIN_MATCH_SCORE)
    .slice(0, 20)
    .map((result) => ({
      ...result,
      matchSource: result.matchSource || 'content',
      matchType: result.matchType || 'text_near',
      reasonLabel: result.reasonLabel || 'Content'
    }));

  const isDuplicate = duplicateResults.some(result => result.isDuplicate);
  const isSuspicious = duplicateResults.some(result => result.isSuspicious && !result.isDuplicate);

  return {
    isDuplicate,
    isSuspicious,
    score: topMatches.length > 0 ? topMatches[0].similarity.overall : 0,
    matchCount: topMatches.length,
    checkedAt: new Date(),
    matchSource: isDuplicate || isSuspicious ? 'content' : null,
    reasonLabel: isDuplicate || isSuspicious ? 'Content' : null,
    reasonMessage:
      isDuplicate || isSuspicious
        ? 'Similar title or text content detected.'
        : null,
    similarArticles: topMatches
  };
}

async function fetchPublishedCorpus(language, excludeId = null) {
  const since = new Date(Date.now() - CORPUS_DAYS * 24 * 60 * 60 * 1000);
  const query = {
    isActive: true,
    publishedAt: { $gte: since },
    language
  };

  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  return News.find(query)
    .select('_id title content publishedAt author category location language contentHash')
    .lean();
}

async function fetchPendingCorpus(language, excludeId = null) {
  const query = {
    isActive: false,
    language,
    $or: [
      { 'rejectionStatus.isRejected': { $ne: true } },
      { rejectionStatus: { $exists: false } }
    ]
  };

  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  return News.find(query)
    .select('_id title content publishedAt author category location language contentHash')
    .sort({ publishedAt: -1 })
    .limit(100)
    .lean();
}

async function findExactHashMatch(contentHash, excludeId = null) {
  if (!contentHash) return null;

  const query = { contentHash };
  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  return News.findOne(query)
    .select('_id title content publishedAt author category location language isActive')
    .lean();
}

async function runDuplicateCheck(article, options = {}) {
  const {
    excludeId = null,
    includePendingCorpus = true
  } = options;

  const title = article.title || '';
  const content = article.content || '';
  const language = (article.language || 'te').toLowerCase();
  const contentHash = generateContentHash(title, content);

  const exactMatch = await findExactHashMatch(contentHash, excludeId);
  if (exactMatch) {
    return {
      contentHash,
      duplicateCheck: buildDuplicateCheckResult([], exactMatch)
    };
  }

  let corpus = await fetchPublishedCorpus(language, excludeId);

  if (includePendingCorpus) {
    const pendingCorpus = await fetchPendingCorpus(language, excludeId);
    corpus = corpus.concat(pendingCorpus);
  }

  const duplicateResults = checkDuplicateFast(
    { title, content, language },
    corpus
  );

  duplicateResults.forEach((result) => {
    const matchedArticle = corpus.find(
      (item) => String(item._id) === String(result.articleId)
    );
    result.content = matchedArticle?.content || '';
  });

  return {
    contentHash,
    duplicateCheck: buildDuplicateCheckResult(duplicateResults)
  };
}

async function applyDuplicateCheckToNews(newsId) {
  const article = await News.findById(newsId)
    .select('title content language')
    .lean();

  if (!article) return null;

  const { contentHash, duplicateCheck } = await runDuplicateCheck(article, {
    excludeId: newsId,
    includePendingCorpus: true
  });

  await News.findByIdAndUpdate(newsId, {
    contentHash,
    duplicateCheck
  });

  return duplicateCheck;
}

module.exports = {
  CORPUS_DAYS,
  MIN_MATCH_SCORE,
  normalizeDuplicateCheck,
  buildDuplicateCheckResult,
  runDuplicateCheck,
  applyDuplicateCheckToNews
};
