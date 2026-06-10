/**
 * Collapse pasted or typed content into a single paragraph (no line breaks).
 */
function normalizeNewsContent(text) {
  if (!text) return '';
  return String(text)
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .trim();
}

module.exports = { normalizeNewsContent };
