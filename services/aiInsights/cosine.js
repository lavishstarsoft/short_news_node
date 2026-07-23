'use strict';

/**
 * Cosine similarity for equal-length embedding vectors.
 * Pure compute — no I/O.
 */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function scoreToPercent(score) {
  if (!Number.isFinite(score)) return 0;
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 10;
}

module.exports = {
  cosineSimilarity,
  scoreToPercent,
};
