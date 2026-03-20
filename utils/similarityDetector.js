const crypto = require('crypto');

/**
 * Calculate Cosine Similarity between two strings (0-100%)
 * Used for detecting similar titles and content
 */
function cosineSimilarity(text1, text2) {
  // Tokenize and convert to lowercase
  const tokens1 = text1.toLowerCase().split(/\W+/).filter(t => t.length > 0);
  const tokens2 = text2.toLowerCase().split(/\W+/).filter(t => t.length > 0);

  // Create frequency maps
  const freq1 = {};
  const freq2 = {};

  tokens1.forEach(token => {
    freq1[token] = (freq1[token] || 0) + 1;
  });

  tokens2.forEach(token => {
    freq2[token] = (freq2[token] || 0) + 1;
  });

  // Get all unique tokens
  const allTokens = new Set([...tokens1, ...tokens2]);

  // Calculate dot product and magnitudes
  let dotProduct = 0;
  let magnitude1 = 0;
  let magnitude2 = 0;

  allTokens.forEach(token => {
    const freq1Val = freq1[token] || 0;
    const freq2Val = freq2[token] || 0;

    dotProduct += freq1Val * freq2Val;
    magnitude1 += freq1Val * freq1Val;
    magnitude2 += freq2Val * freq2Val;
  });

  magnitude1 = Math.sqrt(magnitude1);
  magnitude2 = Math.sqrt(magnitude2);

  // Return similarity as percentage
  if (magnitude1 === 0 || magnitude2 === 0) return 0;
  return Math.round((dotProduct / (magnitude1 * magnitude2)) * 100);
}

/**
 * Levenshtein Distance - for fuzzy matching
 * Detects news with slight modifications
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  const maxLen = Math.max(m, n);
  return Math.round(((maxLen - dp[m][n]) / maxLen) * 100);
}

/**
 * Generate Content Hash
 * Used for quick duplicate detection
 */
function generateContentHash(title, content) {
  const combined = `${title}${content}`.toLowerCase();
  return crypto.createHash('md5').update(combined).digest('hex');
}

/**
 * Extract Keywords from text
 * For keyword-based similarity
 */
function extractKeywords(text, limit = 10) {
  const words = text
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 3); // Only words > 3 chars

  // Remove common stop words
  const stopWords = ['the', 'and', 'with', 'from', 'that', 'this', 'have', 'will', 'about'];
  const filtered = words.filter(w => !stopWords.includes(w));

  // Count frequency
  const frequency = {};
  filtered.forEach(word => {
    frequency[word] = (frequency[word] || 0) + 1;
  });

  // Sort by frequency and return top keywords
  return Object.entries(frequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

/**
 * Calculate Keyword Similarity
 * សរាប់មាន％ keywords overlap
 */
function keywordSimilarity(keywords1, keywords2) {
  const set1 = new Set(keywords1);
  const set2 = new Set(keywords2);

  const intersection = [...set1].filter(k => set2.has(k)).length;
  const union = new Set([...set1, ...set2]).size;

  if (union === 0) return 0;
  return Math.round((intersection / union) * 100);
}

/**
 * Comprehensive Duplicate Check
 * Returns detailed similarity report
 */
function checkDuplicate(newArticle, existingArticles) {
  const results = [];

  existingArticles.forEach(existing => {
    // Title similarity
    const titleSimilarity = cosineSimilarity(newArticle.title, existing.title);
    const titleFuzzy = levenshteinDistance(newArticle.title, existing.title);

    // Content similarity
    const contentSimilarity = cosineSimilarity(
      newArticle.content || '',
      existing.content || ''
    );
    const contentFuzzy = levenshteinDistance(
      newArticle.content || '',
      existing.content || ''
    );

    // Keyword similarity
    const newKeywords = extractKeywords(newArticle.title + ' ' + (newArticle.content || ''));
    const existingKeywords = extractKeywords(
      existing.title + ' ' + (existing.content || '')
    );
    const keywordMatch = keywordSimilarity(newKeywords, existingKeywords);

    // Overall score calculation
    const overallScore = Math.round(
      (titleSimilarity * 0.3 + contentSimilarity * 0.4 + keywordMatch * 0.3)
    );

    results.push({
      articleId: existing._id,
      articleTitle: existing.title,
      publishedAt: existing.publishedAt,
      author: existing.author,
      category: existing.category,
      location: existing.location,
      similarity: {
        title: titleSimilarity,
        titleFuzzy: titleFuzzy,
        content: contentSimilarity,
        contentFuzzy: contentFuzzy,
        keywords: keywordMatch,
        overall: overallScore
      },
      isDuplicate: overallScore >= 80, // >= 80% is duplicate
      isSuspicious: overallScore >= 60 // 60-80% is suspicious
    });
  });

  // Sort by similarity score
  return results.sort((a, b) => b.similarity.overall - a.similarity.overall);
}

/**
 * Batch Hash Generation for existing articles
 */
function generateBatchHashes(articles) {
  return articles.map(article => ({
    ...article,
    contentHash: generateContentHash(article.title || '', article.content || '')
  }));
}

module.exports = {
  cosineSimilarity,
  levenshteinDistance,
  generateContentHash,
  extractKeywords,
  keywordSimilarity,
  checkDuplicate,
  generateBatchHashes
};
