/**
 * Rich text — render tags, contenteditable editors, serialize back to tags
 */
(function (global) {
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function normalizeHexColor(color) {
    if (!color) return '#000000';
    let hex = String(color).trim();
    if (!hex.startsWith('#')) hex = '#' + hex;
    if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
      hex = '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
    }
    return hex.toUpperCase();
  }

  function colorToHex(color) {
    if (!color) return null;
    const trimmed = String(color).trim();
    if (trimmed.startsWith('#')) return normalizeHexColor(trimmed);
    const match = trimmed.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!match) return null;
    const toHex = (n) => parseInt(n, 10).toString(16).padStart(2, '0');
    return ('#' + toHex(match[1]) + toHex(match[2]) + toHex(match[3])).toUpperCase();
  }

  function normalizeToSingleParagraph(text) {
    if (!text) return '';
    return String(text)
      .replace(/[\r\n\u2028\u2029]+/g, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .trim();
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

  function serializeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return ' ';

    let inner = '';
    node.childNodes.forEach((child) => {
      inner += serializeNode(child);
    });

    if (tag === 'b' || tag === 'strong') return `[b]${inner}[/b]`;

    if (tag === 'span' || tag === 'font') {
      const hex = colorToHex(node.style?.color) || colorToHex(node.getAttribute?.('color'));
      if (hex) return `[c=${hex}]${inner}[/c]`;
    }

    if (tag === 'a') return inner;
    if (tag === 'div' || tag === 'p') return inner.trim() ? `${inner.trim()} ` : ' ';

    return inner;
  }

  function htmlToRichTags(root) {
    if (!root) return '';
    let out = '';
    root.childNodes.forEach((child) => {
      out += serializeNode(child);
    });
    return normalizeToSingleParagraph(out.replace(/\u00a0/g, ' '));
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

  const editorState = {};

  function loadEditorFromHidden(editorId, hiddenId) {
    const editor = document.getElementById(editorId);
    const hidden = document.getElementById(hiddenId);
    if (!editor || !hidden) return;
    const tags = hidden.value || '';
    editor.innerHTML = renderRichText(tags) || '';
    if (!editor.textContent.trim() && tags) {
      editor.textContent = stripRichTags(tags);
    }
  }

  function syncRichEditor(editorId, hiddenId, maxPlain, singleLine, singleParagraph) {
    const editor = document.getElementById(editorId);
    const hidden = document.getElementById(hiddenId);
    if (!editor || !hidden) return hidden?.value || '';

    let tags = htmlToRichTags(editor);
    if (singleLine || singleParagraph) tags = normalizeToSingleParagraph(tags);

    const plainLen = stripRichTags(tags).length;
    if (plainLen > maxPlain) {
      tags = trimTagsToPlainLimit(tags, maxPlain);
      hidden.value = tags;
      editorState[hiddenId] = tags;
      loadEditorFromHidden(editorId, hiddenId);
      return tags;
    }

    hidden.value = tags;
    editorState[hiddenId] = tags;
    return tags;
  }

  function initRichEditor(editorId, hiddenId, maxPlain, singleLine, singleParagraph) {
    const editor = document.getElementById(editorId);
    if (!editor) return;

    loadEditorFromHidden(editorId, hiddenId);
    syncRichEditor(editorId, hiddenId, maxPlain, singleLine, singleParagraph);

    editor.addEventListener('input', () => {
      syncRichEditor(editorId, hiddenId, maxPlain, singleLine, singleParagraph);
      if (typeof global.onRichEditorChange === 'function') {
        global.onRichEditorChange(hiddenId, maxPlain);
      }
    });

    editor.addEventListener('paste', (e) => {
      e.preventDefault();
      let text = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (singleLine || singleParagraph) {
        text = normalizeToSingleParagraph(text);
      }
      document.execCommand('insertText', false, text);
    });

    if (singleLine || singleParagraph) {
      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') e.preventDefault();
      });
    }
  }

  function focusEditor(editorId) {
    const editor = document.getElementById(editorId);
    if (editor) editor.focus();
  }

  function applyRichColor(editorId, hiddenId, color, maxPlain, singleLine, singleParagraph) {
    const editor = document.getElementById(editorId);
    if (!editor) return false;
    editor.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !editor.contains(sel.anchorNode)) {
      return false;
    }
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, normalizeHexColor(color));
    syncRichEditor(editorId, hiddenId, maxPlain, singleLine, singleParagraph);
    if (typeof global.onRichEditorChange === 'function') {
      global.onRichEditorChange(hiddenId, maxPlain);
    }
    return true;
  }

  function applyRichBold(editorId, hiddenId, maxPlain, singleLine, singleParagraph) {
    const editor = document.getElementById(editorId);
    if (!editor) return false;
    editor.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !editor.contains(sel.anchorNode)) {
      return false;
    }
    document.execCommand('bold');
    syncRichEditor(editorId, hiddenId, maxPlain, singleLine, singleParagraph);
    if (typeof global.onRichEditorChange === 'function') {
      global.onRichEditorChange(hiddenId, maxPlain);
    }
    return true;
  }

  function removeRichStyling(editorId, hiddenId, maxPlain, singleLine, singleParagraph) {
    const editor = document.getElementById(editorId);
    if (!editor) return false;
    editor.focus();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !editor.contains(sel.anchorNode)) {
      return false;
    }
    document.execCommand('removeFormat');
    document.execCommand('unlink');
    syncRichEditor(editorId, hiddenId, maxPlain, singleLine, singleParagraph);
    if (typeof global.onRichEditorChange === 'function') {
      global.onRichEditorChange(hiddenId, maxPlain);
    }
    return true;
  }

  global.escapeHtml = escapeHtml;
  global.normalizeToSingleParagraph = normalizeToSingleParagraph;
  global.normalizeHexColor = normalizeHexColor;
  global.renderRichText = renderRichText;
  global.stripRichTags = stripRichTags;
  global.htmlToRichTags = htmlToRichTags;
  global.trimTagsToPlainLimit = trimTagsToPlainLimit;
  global.initRichEditor = initRichEditor;
  global.syncRichEditor = syncRichEditor;
  global.applyRichColor = applyRichColor;
  global.applyRichBold = applyRichBold;
  global.removeRichStyling = removeRichStyling;
  global.focusEditor = focusEditor;
})(typeof window !== 'undefined' ? window : global);
