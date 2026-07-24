/**
 * AI Insights — in-page duplicate comparison modal.
 * Loads full articles only on demand. Translation is UI-only + client-cached.
 */
(function (window) {
  'use strict';

  const translateCache = new Map();
  let state = {
    groupId: null,
    originalId: null,
    duplicateId: null,
    data: null,
    displayLang: 'original',
    translated: null,
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDate(v) {
    if (!v) return '—';
    try {
      return new Date(v).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch (_) {
      return '—';
    }
  }

  function ensureDom() {
    if (document.getElementById('aiCompareOverlay')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="ai-compare-overlay" id="aiCompareOverlay" aria-hidden="true">
        <div class="ai-compare-modal" role="dialog" aria-modal="true" aria-labelledby="aiCompareTitle">
          <div class="ai-compare-header">
            <div>
              <h2 id="aiCompareTitle">Compare Articles</h2>
              <div class="sub" id="aiCompareSub">Loading…</div>
            </div>
            <div class="ai-compare-actions">
              <label class="sub" for="aiCompareLang">Translate</label>
              <select id="aiCompareLang">
                <option value="original">Original language</option>
                <option value="en">English</option>
                <option value="hi">Hindi</option>
                <option value="te">Telugu</option>
              </select>
              <button type="button" class="ai-btn ai-btn-ghost" id="aiCompareTranslateBtn">Apply</button>
            </div>
          </div>
          <div class="ai-compare-body" id="aiCompareBody">
            <div class="ai-compare-loading">Loading comparison…</div>
          </div>
          <div class="ai-compare-footer">
            <button type="button" class="ai-btn ai-btn-ghost" id="aiCompareCopy">Copy Content</button>
            <button type="button" class="ai-btn ai-btn-ghost" id="aiCompareImages">Compare Images</button>
            <a class="ai-btn ai-btn-ghost" id="aiCompareOpenOrig" target="_blank" rel="noopener">Open Original</a>
            <a class="ai-btn ai-btn-ghost" id="aiCompareOpenDup" target="_blank" rel="noopener">Open Duplicate</a>
            <button type="button" class="ai-btn ai-btn-primary" id="aiCompareClose">Close</button>
          </div>
        </div>
      </div>
      <div class="ai-img-lightbox" id="aiCompareLightbox">
        <button type="button" class="ai-btn ai-btn-primary close-lb" id="aiCompareLbClose">Close</button>
        <img id="aiCompareLbLeft" alt="Original" />
        <img id="aiCompareLbRight" alt="Duplicate" />
      </div>
    `;
    document.body.appendChild(wrap);

    document.getElementById('aiCompareClose').addEventListener('click', closeCompare);
    document.getElementById('aiCompareOverlay').addEventListener('click', function (e) {
      if (e.target.id === 'aiCompareOverlay') closeCompare();
    });
    document.getElementById('aiCompareCopy').addEventListener('click', copyContent);
    document.getElementById('aiCompareImages').addEventListener('click', openImageCompare);
    document.getElementById('aiCompareLbClose').addEventListener('click', function () {
      document.getElementById('aiCompareLightbox').classList.remove('active');
    });
    document.getElementById('aiCompareTranslateBtn').addEventListener('click', applyTranslation);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.getElementById('aiCompareLightbox').classList.remove('active');
        closeCompare();
      }
    });
  }

  /**
   * Diff helpers take (thisText, otherText, side).
   * Always render THIS side's text; highlight vs the other article.
   * side: 'left' = original column, 'right' = duplicate column (for add/del colors only).
   */
  function wordDiffHtml(selfText, otherText) {
    const words = String(selfText || '').split(/\s+/).filter(Boolean);
    const otherSet = new Set(String(otherText || '').split(/\s+/).filter(Boolean));
    return words
      .map(function (w) {
        if (!otherSet.has(w)) {
          return '<span class="diff-chg">' + esc(w) + '</span>';
        }
        return esc(w);
      })
      .join(' ');
  }

  function paragraphDiffHtml(selfText, otherText, side) {
    const paras = String(selfText || '')
      .split(/\n+/)
      .map(function (p) {
        return p.trim();
      })
      .filter(Boolean);
    const otherParas = String(otherText || '')
      .split(/\n+/)
      .map(function (p) {
        return p.trim();
      })
      .filter(Boolean);
    const otherSet = new Set(otherParas);
    if (!paras.length) {
      return '<span class="diff-del">(empty)</span>';
    }
    return paras
      .map(function (p) {
        if (!otherSet.has(p)) {
          const cls = side === 'left' ? 'diff-del' : 'diff-add';
          return '<p class="' + (otherParas.length ? 'diff-chg' : cls) + '">' + esc(p) + '</p>';
        }
        return '<p>' + esc(p) + '</p>';
      })
      .join('');
  }

  function mediaBlock(article, other) {
    if (!article) return '';
    let html = '';
    const featuredChanged =
      other &&
      String(article.featuredImage || '') !== String(other.featuredImage || '');
    if (featuredChanged) {
      html +=
        '<div class="ai-meta" style="margin-bottom:6px"><span class="diff-chg">Changed Images</span></div>';
    }
    if (article.mediaType === 'video' && (article.videoUrl || article.mediaUrl)) {
      const src = article.videoUrl || article.mediaUrl;
      if (/\.(mp4|webm|ogg)(\?|$)/i.test(src)) {
        html += '<video controls src="' + esc(src) + '"></video>';
      } else {
        html +=
          '<div class="ai-meta">Video: <a href="' +
          esc(src) +
          '" target="_blank" rel="noopener">' +
          esc(src) +
          '</a></div>';
        if (article.thumbnailUrl || article.featuredImage) {
          html +=
            '<img class="' +
            (featuredChanged ? 'diff-img-chg' : '') +
            '" src="' +
            esc(article.thumbnailUrl || article.featuredImage) +
            '" alt="Video thumbnail" />';
        }
      }
    } else if (article.featuredImage) {
      html +=
        '<img class="' +
        (featuredChanged ? 'diff-img-chg' : '') +
        '" src="' +
        esc(article.featuredImage) +
        '" alt="Featured" />';
    }
    const extras = (article.imageUrls || []).filter(function (u) {
      return u && u !== article.featuredImage;
    });
    const otherSet = new Set((other && other.imageUrls) || []);
    if (extras.length) {
      html += '<div class="ai-compare-thumbs">';
      extras.forEach(function (u) {
        const added = other && !otherSet.has(u);
        html +=
          '<img class="' +
          (added ? 'diff-img-add' : '') +
          '" src="' +
          esc(u) +
          '" alt="Attached" />';
      });
      html += '</div>';
    }
    return html || '<div class="ai-meta">No media</div>';
  }

  function aiMetaHtml(ai) {
    if (!ai) return '—';
    const parts = [];
    if (ai.duplicateScore != null) parts.push('Score: ' + ai.duplicateScore);
    if (ai.matchSource) parts.push('Source: ' + ai.matchSource);
    if (ai.reasonLabel) parts.push(ai.reasonLabel);
    if (ai.isDuplicate) parts.push('Flagged duplicate');
    if (ai.isSuspicious) parts.push('Suspicious');
    if (ai.mediaFingerprintStatus) parts.push('Media FP: ' + ai.mediaFingerprintStatus);
    return parts.length ? parts.join(' · ') : '—';
  }

  function renderColumn(article, other, role) {
    if (!article) {
      return '<div class="ai-compare-col"><div class="ai-compare-error">Article missing</div></div>';
    }
    const side = role === 'original' ? 'left' : 'right';
    const titleHtml = wordDiffHtml(article.title, other && other.title);
    const contentHtml = paragraphDiffHtml(article.content, other && other.content, side);
    const label = role === 'original' ? 'Original Article' : 'Duplicate Article';
    return `
      <div class="ai-compare-col ${role}">
        <div class="ai-compare-col-head">
          <h3>${label}</h3>
          <span class="ai-badge ${role === 'original' ? 'ai-badge-original' : 'ai-badge-similar'}">
            ${role === 'original' ? 'ORIGINAL' : 'DUPLICATE'}
          </span>
        </div>
        <div class="ai-compare-title-line">${titleHtml}</div>
        <div class="ai-compare-meta">
          <div class="k">Reporter</div><div class="v">${esc(article.reporter)}</div>
          <div class="k">Language</div><div class="v">${esc(article.language || '—')}</div>
          <div class="k">Category</div><div class="v">${esc(article.category || '—')}</div>
          <div class="k">Location</div><div class="v">${esc(article.location || '—')}</div>
          <div class="k">Scope</div><div class="v">${esc(article.scope || '—')}</div>
          <div class="k">State / District</div><div class="v">${esc(
            [article.state, article.district || (article.scope === 'district' ? article.location : null)]
              .filter(Boolean)
              .join(' / ') || '—'
          )}</div>
          <div class="k">Created</div><div class="v">${esc(fmtDate(article.createdAt))}</div>
          <div class="k">Updated</div><div class="v">${esc(fmtDate(article.updatedAt))}</div>
          <div class="k">Published</div><div class="v">${esc(fmtDate(article.publishedAt))}</div>
          <div class="k">Similarity</div><div class="v">${
            article.similarityPercent != null ? esc(article.similarityPercent) + '%' : '—'
          }</div>
          <div class="k">Status</div><div class="v">${esc(article.status || '—')}</div>
          <div class="k">AI metadata</div><div class="v">${esc(aiMetaHtml(article.aiMetadata))}</div>
        </div>
        <div class="ai-compare-media">${mediaBlock(article, other)}</div>
        <div class="ai-compare-content">${contentHtml}</div>
      </div>
    `;
  }

  function displayArticles() {
    if (!state.data) return { original: null, duplicate: null };
    if (state.displayLang === 'original' || !state.translated) {
      return { original: state.data.original, duplicate: state.data.duplicate };
    }
    return {
      original: Object.assign({}, state.data.original, {
        title: state.translated.originalTitle,
        content: state.translated.originalContent,
      }),
      duplicate: Object.assign({}, state.data.duplicate, {
        title: state.translated.duplicateTitle,
        content: state.translated.duplicateContent,
      }),
    };
  }

  function render() {
    const body = document.getElementById('aiCompareBody');
    if (!state.data) {
      body.innerHTML = '<div class="ai-compare-error">No data</div>';
      return;
    }
    const pair = displayArticles();
    const score = state.data.pairSimilarityPercent;
    document.getElementById('aiCompareSub').textContent =
      'Group #' +
      (state.data.group && state.data.group.groupNumber) +
      (score != null ? ' · Similarity ' + score + '%' : '') +
      (state.displayLang !== 'original' ? ' · Translated (' + state.displayLang + ')' : '');

    body.innerHTML =
      '<div class="ai-compare-legend">' +
      '<span><i class="diff-chg">&nbsp;</i> Changed</span>' +
      '<span><i class="diff-add">&nbsp;</i> Added</span>' +
      '<span><i class="diff-del">&nbsp;</i> Removed / only on this side</span>' +
      '</div>' +
      '<div class="ai-compare-grid">' +
      renderColumn(pair.original, pair.duplicate, 'original') +
      renderColumn(pair.duplicate, pair.original, 'duplicate') +
      '</div>';

    document.getElementById('aiCompareOpenOrig').href = '/edit-news/' + state.originalId;
    document.getElementById('aiCompareOpenDup').href = '/edit-news/' + state.duplicateId;
  }

  async function applyTranslation() {
    const lang = document.getElementById('aiCompareLang').value;
    if (!state.data) return;
    if (lang === 'original') {
      state.displayLang = 'original';
      state.translated = null;
      render();
      return;
    }

    const cacheKey = state.groupId + ':' + state.originalId + ':' + state.duplicateId + ':' + lang;
    if (translateCache.has(cacheKey)) {
      state.translated = translateCache.get(cacheKey);
      state.displayLang = lang;
      render();
      return;
    }

    const btn = document.getElementById('aiCompareTranslateBtn');
    btn.disabled = true;
    btn.textContent = 'Translating…';
    try {
      const texts = [
        state.data.original.title || '',
        state.data.original.content || '',
        state.data.duplicate.title || '',
        state.data.duplicate.content || '',
      ];
      const res = await fetch('/admin/api/ai-insights/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          texts: texts,
          targetLang: lang,
          sourceLang: 'auto',
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error('fail');
      const t = data.translations || [];
      state.translated = {
        originalTitle: t[0] || texts[0],
        originalContent: t[1] || texts[1],
        duplicateTitle: t[2] || texts[2],
        duplicateContent: t[3] || texts[3],
      };
      translateCache.set(cacheKey, state.translated);
      state.displayLang = lang;
      render();
    } catch (e) {
      alert('Translation failed. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Apply';
    }
  }

  function copyContent() {
    const pair = displayArticles();
    if (!pair.original || !pair.duplicate) return;
    const text =
      'ORIGINAL\n' +
      pair.original.title +
      '\n\n' +
      pair.original.content +
      '\n\n---\n\nDUPLICATE\n' +
      pair.duplicate.title +
      '\n\n' +
      pair.duplicate.content;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          alert('Copied both articles to clipboard');
        },
        function () {
          alert('Could not copy');
        }
      );
    } else {
      alert('Clipboard not available');
    }
  }

  function openImageCompare() {
    if (!state.data) return;
    const lb = document.getElementById('aiCompareLightbox');
    const left = state.data.original.featuredImage;
    const right = state.data.duplicate.featuredImage;
    document.getElementById('aiCompareLbLeft').src = left || '';
    document.getElementById('aiCompareLbRight').src = right || '';
    document.getElementById('aiCompareLbLeft').style.display = left ? 'block' : 'none';
    document.getElementById('aiCompareLbRight').style.display = right ? 'block' : 'none';
    lb.classList.add('active');
  }

  function closeCompare() {
    const overlay = document.getElementById('aiCompareOverlay');
    if (!overlay) return;
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
    state.displayLang = 'original';
    state.translated = null;
    const lang = document.getElementById('aiCompareLang');
    if (lang) lang.value = 'original';
  }

  async function openCompare(groupId, originalId, duplicateId) {
    ensureDom();
    state.groupId = groupId;
    state.originalId = originalId;
    state.duplicateId = duplicateId;
    state.data = null;
    state.translated = null;
    state.displayLang = 'original';

    const overlay = document.getElementById('aiCompareOverlay');
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    document.getElementById('aiCompareBody').innerHTML =
      '<div class="ai-compare-loading">Loading full articles…</div>';
    document.getElementById('aiCompareSub').textContent = 'Fetching details…';
    document.getElementById('aiCompareLang').value = 'original';

    try {
      const url =
        '/admin/api/ai-insights/groups/' +
        encodeURIComponent(groupId) +
        '/compare?left=' +
        encodeURIComponent(originalId) +
        '&right=' +
        encodeURIComponent(duplicateId);
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'fail');
      state.data = data;
      // Prefer canonical original/duplicate from API
      if (data.original && data.original.id) state.originalId = data.original.id;
      if (data.duplicate && data.duplicate.id) state.duplicateId = data.duplicate.id;
      render();
    } catch (e) {
      document.getElementById('aiCompareBody').innerHTML =
        '<div class="ai-compare-error">Could not load comparison. Please try again.</div>';
    }
  }

  window.AiInsightsCompare = {
    open: openCompare,
    close: closeCompare,
  };
})(window);
