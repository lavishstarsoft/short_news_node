/**
 * Server-side rich text rendering — mirrors public/js/rich-text.js
 * Converts [c=#RRGGBB]text[/c] and [b]text[/b] to safe HTML for dashboard display.
 */

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function linkify(segment) {
  return segment.replace(
    /(https?:\/\/[^\s<>&"]+)/gi,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
}

function wrapSegment(segment, color, bold) {
  let html = linkify(escapeHtml(segment));
  if (bold) html = `<strong>${html}</strong>`;
  if (color) html = `<span style="color:${color}">${html}</span>`;
  return html;
}

function renderRichText(text) {
  if (!text) return '';

  const tagRegex = /(\[c=(#[0-9a-fA-F]{6})\])|(\[\/c\])|(\[b\])|(\[\/b\])/gi;
  let html = '';
  let currentIndex = 0;
  let currentColor = null;
  let isBold = false;
  const matches = [...String(text).matchAll(tagRegex)];

  function flush(end) {
    if (end <= currentIndex) return;
    html += wrapSegment(text.substring(currentIndex, end), currentColor, isBold);
  }

  for (const match of matches) {
    flush(match.index);
    if (match[1]) currentColor = match[2];
    else if (match[3]) currentColor = null;
    else if (match[4]) isBold = true;
    else if (match[5]) isBold = false;
    currentIndex = match.index + match[0].length;
  }

  flush(text.length);
  return html.replace(/[\r\n\u2028\u2029]+/g, ' ');
}

function stripRichTags(text) {
  if (!text) return '';
  return String(text)
    .replace(/\[c=#[0-9a-fA-F]{6}\]/gi, '')
    .replace(/\[\/c\]/gi, '')
    .replace(/\[b\]/gi, '')
    .replace(/\[\/b\]/gi, '');
}

function trimTagsToPlainLimit(text, max) {
  if (!text) return '';
  let plainLength = 0;
  let result = '';
  let i = 0;
  while (i < text.length && plainLength < max) {
    const colorTagMatch = text.substring(i).match(/^\[c=#[0-9a-fA-F]{6}\]|^\[\/c\]/i);
    const boldTagMatch = text.substring(i).match(/^\[b\]|^\[\/b\]/i);
    if (colorTagMatch) {
      result += colorTagMatch[0];
      i += colorTagMatch[0].length;
    } else if (boldTagMatch) {
      result += boldTagMatch[0];
      i += boldTagMatch[0].length;
    } else {
      result += text[i];
      plainLength++;
      i++;
    }
  }
  return result;
}

function renderRichTextExcerpt(text, maxPlain = 120) {
  if (!text) return '';
  const plain = stripRichTags(text);
  if (plain.length <= maxPlain) {
    return renderRichText(text);
  }
  return `${renderRichText(trimTagsToPlainLimit(text, maxPlain))}…`;
}

module.exports = {
  escapeHtml,
  renderRichText,
  renderRichTextExcerpt,
  stripRichTags,
  trimTagsToPlainLimit
};
