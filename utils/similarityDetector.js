const crypto = require('crypto');
const { detectPrimaryLanguage } = require('./languageUtils');

const LANG_CODE_MAP = {
  telugu: 'te',
  hindi: 'hi',
  tamil: 'ta',
  english: 'en',
  kannada: 'kn',
  malayalam: 'ml'
};

// \u2500\u2500 Tunable thresholds (env-driven, safe defaults preserve prior behaviour) \u2500\u2500
function numEnv(key, fallback) {
  const n = parseFloat(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
}
function boolEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}
// Title cosine below this normally skips a candidate. Lowered from the old hard
// 25 so a reworded headline with the SAME body is still compared.
const TITLE_GATE = numEnv('DUP_TITLE_GATE', 12);
// \u2026but if the body is this similar, compare regardless of the title (headline
// fully rewritten, story identical).
const CONTENT_BYPASS = numEnv('DUP_CONTENT_BYPASS', 55);
// Recurring-topic guard: gold/veg/petrol/weather/horoscope daily updates keep
// their NUMBERS in the comparison (different prices \u21D2 lower similarity) and a
// "duplicate" verdict is downgraded to "suspicious" (advisory, never hard-block).
const RECURRING_GUARD = boolEnv('DUP_RECURRING_GUARD', true);

const RECURRING_TOPIC_PATTERNS = [
  /\u0C2C\u0C02\u0C17\u0C3E\u0C30/, /\u0C35\u0C46\u0C02\u0C21\u0C3F/, /\u0C17\u0C4B\u0C32\u0C4D\u0C21\u0C4D/, /gold\s*rate/i, /silver/i,
  /\u0C15\u0C42\u0C30\u0C17\u0C3E\u0C2F/, /vegetable/i, /\u0C2A\u0C46\u0C1F\u0C4D\u0C30\u0C4B\u0C32/, /\u0C21\u0C40\u0C1C\u0C3F\u0C32/, /petrol/i, /diesel/i,
  /\u0C35\u0C3E\u0C24\u0C3E\u0C35\u0C30\u0C23/, /weather/i, /\u0C09\u0C37\u0C4D\u0C23\u0C4B\u0C17\u0C4D\u0C30\u0C24/, /temperature/i,
  /\u0C30\u0C3E\u0C36\u0C3F|\u0C30\u0C3E\u0C36\u0C3F\u0C2B\u0C32|\u0C1C\u0C3E\u0C24\u0C15|\u0C2A\u0C02\u0C1A\u0C3E\u0C02\u0C17/, /horoscope/i, /panchang/i, /rashi/i,
  /\u0C2E\u0C3E\u0C30\u0C4D\u0C15\u0C46\u0C1F\u0C4D\s*(\u0C30\u0C47\u0C1F\u0C4D|\u0C27\u0C30)/, /market\s*rate/i
];

/** Is this article a recurring daily-update topic (price/weather/horoscope\u2026)? */
function isRecurringTopic(article = {}) {
  const hay = `${article.title || ''} ${article.category || ''}`.toLowerCase();
  return RECURRING_TOPIC_PATTERNS.some((re) => re.test(hay));
}

/**
 * Tokens that should not influence duplicate scoring (numbers, years, etc.).
 * When keepNumbers=true (recurring topics), numeric tokens ARE kept because the
 * numbers (prices, temperatures) are exactly what distinguishes each day's news.
 */
function isNoiseToken(token, keepNumbers = false) {
  if (!token) return true;
  const value = token.toLowerCase();
  const numeric = /^\d[\d,.]*$/.test(value);
  if (keepNumbers && numeric) return false;
  if (value.length <= 2) return true;
  if (numeric) return true;
  if (/^(19|20)\d{2}$/.test(value)) return true;
  return false;
}

const INDIC_WORD_REGEX = /[\u0900-\u097F\u0C00-\u0C7F\u0B80-\u0BFF\u0C80-\u0CFF\u0D00-\u0D7Fa-z0-9]+/g;

function tokenizeForSimilarity(text, opts = {}) {
  const normalized = String(text || '').toLowerCase();
  const tokens = normalized.match(INDIC_WORD_REGEX) || [];
  return tokens.filter(token => !isNoiseToken(token, opts.keepNumbers));
}

function normalizeLangCode(lang) {
  if (!lang) return null;
  const normalized = String(lang).toLowerCase().trim();
  return LANG_CODE_MAP[normalized] || normalized;
}

function languagesCompatible(article1, article2) {
  const lang1 = normalizeLangCode(article1?.language);
  const lang2 = normalizeLangCode(article2?.language);
  if (lang1 && lang2 && lang1 !== lang2) return false;
  return true;
}

/**
 * Skip comparisons when both texts clearly use different scripts (e.g. Telugu vs Hindi).
 */
function scriptsCompatible(text1, text2) {
  const detection1 = detectPrimaryLanguage(text1);
  const detection2 = detectPrimaryLanguage(text2);
  if (!detection1?.language || !detection2?.language) return true;

  const script1 = detection1.language;
  const script2 = detection2.language;
  if (script1 === script2) return true;

  const count1 = detection1.percentages?.[script1] || 0;
  const count2 = detection2.percentages?.[script2] || 0;
  const total1 = Object.values(detection1.percentages || {}).reduce((sum, n) => sum + n, 0) || 1;
  const total2 = Object.values(detection2.percentages || {}).reduce((sum, n) => sum + n, 0) || 1;

  const strength1 = count1 / total1;
  const strength2 = count2 / total2;

  if (strength1 >= 0.25 && strength2 >= 0.25) return false;
  return true;
}

function computeOverallScore(titleSimilarity, contentSimilarity, keywordMatch) {
  let overall = Math.round(
    titleSimilarity * 0.2 + contentSimilarity * 0.5 + keywordMatch * 0.3
  );

  // Title-only overlap (often numbers) should not inflate duplicate score.
  if (contentSimilarity < 15 && titleSimilarity > 25) {
    overall = Math.min(overall, 35);
  }
  if (contentSimilarity < 20) {
    overall = Math.min(overall, 55);
  }

  return overall;
}

function classifyDuplicateMatch(overallScore, contentSimilarity) {
  // Hard duplicate: strong overall + strong body, OR the body itself is near
  // identical (headline fully rewritten but the story is the same).
  const isDuplicate =
    (overallScore >= 80 && contentSimilarity >= 55) || contentSimilarity >= 85;
  const isSuspicious =
    !isDuplicate && overallScore >= 55 && contentSimilarity >= 35;
  return { isDuplicate, isSuspicious };
}

/**
 * Calculate Cosine Similarity between two strings (0-100%)
 * Used for detecting similar titles and content
 */
function cosineSimilarity(text1, text2, opts = {}) {
  const tokens1 = tokenizeForSimilarity(text1, opts);
  const tokens2 = tokenizeForSimilarity(text2, opts);

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
function extractKeywords(text, limit = 10, opts = {}) {
  const words = tokenizeForSimilarity(text, opts)
    .filter(word => word.length > 2); // Meaningful words (Indic + English)

  const stopWords = [
    'the', 'and', 'with', 'from', 'that', 'this', 'have', 'will', 'about',
    'news', 'live', 'update', 'updates', 'breaking', 'latest'
  ];
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
    if (!languagesCompatible(newArticle, existing)) return;

    const newCombined = `${newArticle.title || ''} ${newArticle.content || ''}`;
    const existingCombined = `${existing.title || ''} ${existing.content || ''}`;
    if (!scriptsCompatible(newCombined, existingCombined)) return;

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

    const overallScore = computeOverallScore(titleSimilarity, contentSimilarity, keywordMatch);
    const classification = classifyDuplicateMatch(overallScore, contentSimilarity);

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
      isDuplicate: classification.isDuplicate,
      isSuspicious: classification.isSuspicious
    });
  });

  // Sort by similarity score
  return results.sort((a, b) => b.similarity.overall - a.similarity.overall);
}

/**
 * FAST Duplicate Check (optimized for pending news page)
 * - Skips Levenshtein (O(n²) per pair) — uses only Cosine + Keywords (O(n) per pair)
 * - Pre-computes new article keywords ONCE outside the loop
 * - Early exits when title similarity < 25%
 * - ~99% faster than checkDuplicate for large datasets
 */
function checkDuplicateFast(newArticle, existingArticles, options = {}) {
  const results = [];

  // Recurring daily-update topic? (price/weather/horoscope). When so, keep the
  // numbers in scoring and downgrade any hard "duplicate" to "suspicious".
  const recurring =
    options.recurring !== undefined
      ? !!options.recurring
      : RECURRING_GUARD && isRecurringTopic(newArticle);
  const tokOpts = recurring ? { keepNumbers: true } : {};

  // Pre-compute keywords for new article ONCE (not inside loop)
  const newKeywords = extractKeywords(
    (newArticle.title || '') + ' ' + (newArticle.content || ''),
    10,
    tokOpts
  );

  const newCombined = `${newArticle.title || ''} ${newArticle.content || ''}`;

  for (let i = 0; i < existingArticles.length; i++) {
    const existing = existingArticles[i];

    if (!languagesCompatible(newArticle, existing)) continue;

    const existingCombined = `${existing.title || ''} ${existing.content || ''}`;
    if (!scriptsCompatible(newCombined, existingCombined)) continue;

    // Step 1: Quick title cosine check
    const titleSimilarity = cosineSimilarity(newArticle.title || '', existing.title || '', tokOpts);

    // Step 2: Content cosine similarity. A low-title candidate is NOT skipped
    // outright — a reworded headline over the SAME body must still be caught —
    // it is skipped only when the body is also unrelated (< CONTENT_BYPASS).
    const contentSimilarity = cosineSimilarity(
      newArticle.content || '',
      existing.content || '',
      tokOpts
    );
    if (titleSimilarity < TITLE_GATE && contentSimilarity < CONTENT_BYPASS) continue;

    // Step 3: Keyword similarity
    const existingKeywords = extractKeywords(
      (existing.title || '') + ' ' + (existing.content || ''),
      10,
      tokOpts
    );
    const keywordMatch = keywordSimilarity(newKeywords, existingKeywords);

    const overallScore = computeOverallScore(titleSimilarity, contentSimilarity, keywordMatch);
    const classification = classifyDuplicateMatch(overallScore, contentSimilarity);

    // Recurring-topic guard: never HARD-block a daily update — downgrade to
    // suspicious so the editor still sees it but genuine new numbers pass.
    if (recurring && classification.isDuplicate) {
      classification.isDuplicate = false;
      classification.isSuspicious = true;
    }

    // Only include if overall >= 40% (skip irrelevant matches)
    if (overallScore >= 40) {
      results.push({
        articleId: existing._id,
        articleTitle: existing.title,
        publishedAt: existing.publishedAt,
        author: existing.author,
        category: existing.category,
        location: existing.location,
        similarity: {
          title: titleSimilarity,
          content: contentSimilarity,
          keywords: keywordMatch,
          overall: overallScore
        },
        isDuplicate: classification.isDuplicate,
        isSuspicious: classification.isSuspicious,
        recurring
      });
    }
  }

  // Sort by similarity score descending
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
  isNoiseToken,
  tokenizeForSimilarity,
  isRecurringTopic,
  languagesCompatible,
  scriptsCompatible,
  computeOverallScore,
  classifyDuplicateMatch,
  checkDuplicate,
  checkDuplicateFast,
  generateBatchHashes
};

