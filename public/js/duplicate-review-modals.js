/**
 * Duplicate review UI for add-news publish gate.
 * Warning dialog + lazy comparison modal. Detection logic unchanged.
 */
(function (window) {
  'use strict';

  const translateCache = new Map();
  let state = {
    checkData: null,
    matches: [],
    selectedIndex: 0,
    draft: null,
    reference: null,
    displayLang: 'original',
    translated: null,
  };
  let callbacks = {
    onIgnoreWarning: null,
    onContinueEditing: null,
    onCancelSubmission: null,
    getDraftSnapshot: null,
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

  function overall(match) {
    if (!match) return 0;
    if (typeof match.similarity === 'number') return match.similarity;
    if (match.similarity && typeof match.similarity.overall === 'number') {
      return match.similarity.overall;
    }
    return 0;
  }

  function breakdown(match) {
    const sim = (match && match.similarity) || {};
    const ov = overall(match);
    const src = (match && match.matchSource) || 'content';
    const title = typeof sim.title === 'number' ? sim.title : null;
    const content = typeof sim.content === 'number' ? sim.content : null;
    let image = null;
    if (src === 'image' || src === 'both') {
      image = ov;
    }
    return {
      title: title,
      content: content,
      image: image,
      overall: ov,
      source: src,
    };
  }

  function statusMeta(score, isDup, isSus) {
    if (isDup || score >= 80) {
      return { label: 'High Confidence Duplicate', className: 'dr-status--high' };
    }
    if (isSus || score >= 60) {
      return { label: 'Possible Duplicate', className: 'dr-status--mid' };
    }
    return { label: 'Low Confidence Match', className: 'dr-status--low' };
  }

  function scoreClass(value) {
    if (value == null) return 'is-muted';
    if (value >= 80) return 'is-red';
    if (value >= 60) return 'is-orange';
    return 'is-yellow';
  }

  function scoreLabel(value) {
    return value == null ? 'N/A' : value + '%';
  }

  function mediaUrlOf(item) {
    if (!item) return '';
    return (
      item.mediaUrl ||
      item.thumbnailUrl ||
      item.imageUrl ||
      (Array.isArray(item.imageUrls) && item.imageUrls[0]) ||
      ''
    );
  }

  function wordDiffHtml(selfText, otherText) {
    const words = String(selfText || '').split(/\s+/).filter(Boolean);
    const otherSet = new Set(String(otherText || '').split(/\s+/).filter(Boolean));
    return words
      .map(function (w) {
        return otherSet.has(w) ? esc(w) : '<span class="diff-chg">' + esc(w) + '</span>';
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
    if (!paras.length) return '<span class="diff-del">(empty)</span>';
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

  function ensureDom() {
    if (document.getElementById('drWarnOverlay')) return;

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="dr-overlay" id="drWarnOverlay" aria-hidden="true">
        <div class="dr-modal" role="dialog" aria-modal="true" aria-labelledby="drWarnTitle">
          <div class="dr-header">
            <div>
              <h3 id="drWarnTitle">Duplicate Detected</h3>
              <p class="sub" id="drWarnSub">Review the reference article before deciding.</p>
            </div>
            <span class="dr-status" id="drWarnStatus">—</span>
          </div>
          <div class="dr-body" id="drWarnBody"></div>
          <div class="dr-footer">
            <button type="button" class="dr-btn dr-btn-danger" id="drWarnCancel">Cancel Submission</button>
            <button type="button" class="dr-btn dr-btn-ghost" id="drWarnContinue">Continue Editing</button>
            <button type="button" class="dr-btn" id="drWarnIgnore">Ignore Warning</button>
            <button type="button" class="dr-btn dr-btn-primary" id="drWarnView">View Reference</button>
          </div>
        </div>
      </div>
      <div class="dr-overlay" id="drCompareOverlay" aria-hidden="true">
        <div class="dr-modal dr-modal--wide" role="dialog" aria-modal="true" aria-labelledby="drCompareTitle">
          <div class="dr-header">
            <div>
              <h3 id="drCompareTitle">Compare Articles</h3>
              <p class="sub" id="drCompareSub">Reference vs current draft</p>
            </div>
            <div class="dr-compare-toolbar">
              <label class="sub" for="drCompareLang">Translate</label>
              <select id="drCompareLang">
                <option value="original">Original language</option>
                <option value="en">English</option>
                <option value="hi">Hindi</option>
                <option value="te">Telugu</option>
              </select>
              <button type="button" class="dr-btn" id="drCompareTranslate">Apply</button>
            </div>
          </div>
          <div class="dr-body" id="drCompareBody">
            <div class="dr-loading">Loading reference article…</div>
          </div>
          <div class="dr-footer">
            <button type="button" class="dr-btn dr-btn-ghost" id="drCompareBack">Back to Warning</button>
            <button type="button" class="dr-btn" id="drCompareIgnore">Ignore Warning</button>
            <button type="button" class="dr-btn dr-btn-primary" id="drCompareClose">Continue Editing</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    document.getElementById('drWarnCancel').addEventListener('click', function () {
      closeAll();
      if (callbacks.onCancelSubmission) callbacks.onCancelSubmission();
    });
    document.getElementById('drWarnContinue').addEventListener('click', function () {
      closeAll();
      if (callbacks.onContinueEditing) callbacks.onContinueEditing();
    });
    document.getElementById('drWarnIgnore').addEventListener('click', function () {
      closeAll();
      if (callbacks.onIgnoreWarning) callbacks.onIgnoreWarning();
    });
    document.getElementById('drWarnView').addEventListener('click', openCompare);
    document.getElementById('drCompareBack').addEventListener('click', function () {
      closeCompare();
      openWarningFromState();
    });
    document.getElementById('drCompareIgnore').addEventListener('click', function () {
      closeAll();
      if (callbacks.onIgnoreWarning) callbacks.onIgnoreWarning();
    });
    document.getElementById('drCompareClose').addEventListener('click', function () {
      closeAll();
      if (callbacks.onContinueEditing) callbacks.onContinueEditing();
    });
    document.getElementById('drCompareTranslate').addEventListener('click', applyTranslation);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (document.getElementById('drCompareOverlay').classList.contains('active')) {
          closeCompare();
          openWarningFromState();
        } else if (document.getElementById('drWarnOverlay').classList.contains('active')) {
          closeAll();
          if (callbacks.onContinueEditing) callbacks.onContinueEditing();
        }
      }
    });
  }

  function renderScoreCards(bd) {
    return `
      <div class="dr-scores">
        <div class="dr-score-card ${scoreClass(bd.image)}">
          <span class="k">Image Similarity</span>
          <span class="v">${esc(scoreLabel(bd.image))}</span>
        </div>
        <div class="dr-score-card ${scoreClass(bd.content)}">
          <span class="k">Content Similarity</span>
          <span class="v">${esc(scoreLabel(bd.content))}</span>
        </div>
        <div class="dr-score-card ${scoreClass(bd.title)}">
          <span class="k">Title Similarity</span>
          <span class="v">${esc(scoreLabel(bd.title))}</span>
        </div>
      </div>
    `;
  }

  function renderReferenceCard(match, selected) {
    const bd = breakdown(selected);
    const thumb = mediaUrlOf(selected);
    const thumbHtml = thumb
      ? `<img class="dr-ref-thumb" src="${esc(thumb)}" alt="Reference thumbnail" />`
      : `<div class="dr-ref-thumb dr-ref-thumb--empty">No image</div>`;
    return `
      <div class="dr-ref-card">
        <div class="dr-ref-card-head">
          ${thumbHtml}
          <div class="dr-ref-main">
            <h4>${esc(selected.articleTitle || selected.title || 'Untitled article')}</h4>
            <div class="dr-ref-meta">
              <div class="k">Reporter</div><div class="v">${esc(selected.author || '—')}</div>
              <div class="k">Language</div><div class="v">${esc(selected.language || '—')}</div>
              <div class="k">Category</div><div class="v">${esc(selected.category || '—')}</div>
              <div class="k">Location</div><div class="v">${esc(selected.location || '—')}</div>
              <div class="k">State</div><div class="v">${esc(selected.state || (selected.scope === 'state' ? selected.location : null) || '—')}</div>
              <div class="k">District</div><div class="v">${esc(selected.district || (selected.scope === 'district' ? selected.location : null) || '—')}</div>
              <div class="k">Published</div><div class="v">${esc(fmtDate(selected.publishedAt))}</div>
              <div class="k">Status</div><div class="v">${esc(
                selected.publishStatus === 'published'
                  ? 'Published'
                  : selected.publishStatus === 'rejected'
                    ? 'Rejected'
                    : selected.isActive === true
                      ? 'Published'
                      : 'Not published'
              )}</div>
            </div>
          </div>
        </div>
        <div class="dr-ref-scores">
          <span class="dr-chip">Overall ${esc(String(bd.overall))}%</span>
          <span class="dr-chip">Image ${esc(scoreLabel(bd.image))}</span>
          <span class="dr-chip">Content ${esc(scoreLabel(bd.content))}</span>
          <span class="dr-chip">Title ${esc(scoreLabel(bd.title))}</span>
          <span class="dr-chip">${esc(selected.reasonLabel || selected.matchSource || 'Match')}</span>
        </div>
      </div>
    `;
  }

  function renderMatchList(matches, selectedIndex) {
    if (!matches.length) return '';
    return `
      <div class="dr-match-list">
        <div class="dr-match-list-label">Matched articles (${matches.length})</div>
        ${matches
          .map(function (m, idx) {
            return `
              <button type="button" class="dr-match-item${idx === selectedIndex ? ' is-active' : ''}" data-dr-match="${idx}">
                <div class="dr-match-item-top">
                  <span>#${idx + 1} · ${esc(m.reasonLabel || m.matchSource || 'Match')}</span>
                  <span>${esc(String(overall(m)))}%</span>
                </div>
                <div>${esc(m.articleTitle || 'Untitled article')}</div>
              </button>
            `;
          })
          .join('')}
      </div>
    `;
  }

  function renderWarningBody() {
    const matches = state.matches;
    const selected = matches[state.selectedIndex] || matches[0] || {};
    const dc = (state.checkData && state.checkData.duplicateCheck) || {};
    const score =
      typeof (state.checkData && state.checkData.score) === 'number'
        ? state.checkData.score
        : dc.score || overall(selected);
    const isDup = state.checkData.hasDuplicate === true || dc.isDuplicate === true;
    const isSus = state.checkData.isSuspicious === true || dc.isSuspicious === true;
    const status = statusMeta(score, isDup, isSus);
    const bd = breakdown(selected);

    const statusEl = document.getElementById('drWarnStatus');
    statusEl.className = 'dr-status ' + status.className;
    statusEl.textContent = status.label;
    document.getElementById('drWarnSub').textContent =
      'Top match ' + score + '% · ' + matches.length + ' matched article' + (matches.length === 1 ? '' : 's');

    document.getElementById('drWarnBody').innerHTML =
      renderScoreCards(bd) +
      '<div class="dr-match-list-label">Reference Article</div>' +
      renderReferenceCard(matches, selected) +
      renderMatchList(matches, state.selectedIndex);

    document.querySelectorAll('[data-dr-match]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.selectedIndex = Number(btn.getAttribute('data-dr-match')) || 0;
        state.reference = null;
        state.translated = null;
        state.displayLang = 'original';
        renderWarningBody();
      });
    });
  }

  function openWarningFromState() {
    ensureDom();
    const overlay = document.getElementById('drWarnOverlay');
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    renderWarningBody();
  }

  function showWarning(checkData, opts) {
    callbacks = Object.assign(callbacks, opts || {});
    state.checkData = checkData || {};
    state.matches =
      checkData.similarArticles ||
      (checkData.duplicateCheck && checkData.duplicateCheck.similarArticles) ||
      [];
    state.selectedIndex = 0;
    state.reference = null;
    state.translated = null;
    state.displayLang = 'original';
    state.draft = callbacks.getDraftSnapshot ? callbacks.getDraftSnapshot() : null;
    openWarningFromState();
  }

  function closeWarning() {
    const overlay = document.getElementById('drWarnOverlay');
    if (!overlay) return;
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function closeCompare() {
    const overlay = document.getElementById('drCompareOverlay');
    if (!overlay) return;
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function closeAll() {
    closeCompare();
    closeWarning();
  }

  function renderCompareColumn(article, other, role) {
    if (!article) {
      return '<div class="dr-col"><div class="dr-error">Article missing</div></div>';
    }
    const side = role === 'ref' ? 'left' : 'right';
    const titleHtml = wordDiffHtml(article.title, other && other.title);
    const contentHtml = paragraphDiffHtml(article.content, other && other.content, side);
    const media = mediaUrlOf(article);
    let mediaHtml = '<div class="dr-meta" style="color:#94a3b8;font-weight:700">No media</div>';
    if (article.mediaType === 'video' && (article.videoUrl || article.mediaUrl)) {
      const src = article.videoUrl || article.mediaUrl;
      if (/\.(mp4|webm|ogg)(\?|$)/i.test(src)) {
        mediaHtml = '<video controls src="' + esc(src) + '"></video>';
      } else {
        mediaHtml =
          '<div style="font-size:0.8rem;font-weight:700;margin-bottom:6px">Video link</div>' +
          (media ? '<img src="' + esc(media) + '" alt="Video thumb" />' : '');
      }
    } else if (media) {
      mediaHtml = '<img src="' + esc(media) + '" alt="Article image" />';
    }
    const extras = (article.imageUrls || []).filter(function (u) {
      return u && u !== media;
    });
    if (extras.length) {
      mediaHtml +=
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' +
        extras
          .map(function (u) {
            return '<img src="' + esc(u) + '" alt="Attached" style="width:64px;height:64px;object-fit:cover;border-radius:8px" />';
          })
          .join('') +
        '</div>';
    }

    return `
      <div class="dr-col dr-col--${role}">
        <div class="dr-col-head">
          <h4>${role === 'ref' ? 'Reference Article' : 'Current Draft'}</h4>
          <span class="dr-chip">${role === 'ref' ? 'LEFT' : 'RIGHT'}</span>
        </div>
        <div class="dr-col-title">${titleHtml}</div>
        <div class="dr-col-meta">
          <div class="k">Reporter</div><div class="v">${esc(article.author || article.reporter || '—')}</div>
          <div class="k">Language</div><div class="v">${esc(article.language || '—')}</div>
          <div class="k">Category</div><div class="v">${esc(article.category || '—')}</div>
          <div class="k">Location</div><div class="v">${esc(article.location || '—')}</div>
        </div>
        <div class="dr-col-media">${mediaHtml}</div>
        <div class="dr-col-content">${contentHtml}</div>
      </div>
    `;
  }

  function displayPair() {
    const ref = state.reference;
    const draft = state.draft || {};
    if (state.displayLang === 'original' || !state.translated) {
      return { ref: ref, draft: draft };
    }
    return {
      ref: Object.assign({}, ref, {
        title: state.translated.refTitle,
        content: state.translated.refContent,
      }),
      draft: Object.assign({}, draft, {
        title: state.translated.draftTitle,
        content: state.translated.draftContent,
      }),
    };
  }

  function renderCompare() {
    const pair = displayPair();
    const selected = state.matches[state.selectedIndex] || {};
    const bd = breakdown(selected);
    document.getElementById('drCompareSub').textContent =
      'Overall ' +
      bd.overall +
      '% · Image ' +
      scoreLabel(bd.image) +
      ' · Content ' +
      scoreLabel(bd.content) +
      (state.displayLang !== 'original' ? ' · Translated (' + state.displayLang + ')' : '');

    document.getElementById('drCompareBody').innerHTML =
      '<div class="dr-legend">' +
      '<span><i class="diff-chg"></i> Changed</span>' +
      '<span><i class="diff-add"></i> Added</span>' +
      '<span><i class="diff-del"></i> Removed / only on this side</span>' +
      '</div>' +
      '<div class="dr-compare-grid">' +
      renderCompareColumn(pair.ref, pair.draft, 'ref') +
      renderCompareColumn(pair.draft, pair.ref, 'draft') +
      '</div>';
  }

  async function openCompare() {
    ensureDom();
    closeWarning();
    const overlay = document.getElementById('drCompareOverlay');
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    document.getElementById('drCompareLang').value = 'original';
    state.displayLang = 'original';
    state.translated = null;
    state.draft = callbacks.getDraftSnapshot ? callbacks.getDraftSnapshot() : state.draft;

    const selected = state.matches[state.selectedIndex] || {};
    const refId = selected.articleId;
    if (!refId) {
      document.getElementById('drCompareBody').innerHTML =
        '<div class="dr-error">Reference article id missing.</div>';
      return;
    }

    if (state.reference && state.reference.id === String(refId)) {
      renderCompare();
      return;
    }

    document.getElementById('drCompareBody').innerHTML =
      '<div class="dr-loading">Loading full reference article…</div>';

    try {
      const res = await fetch('/admin/api/duplicate-reference/' + encodeURIComponent(refId));
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'fail');
      state.reference = data.article;
      renderCompare();
    } catch (e) {
      document.getElementById('drCompareBody').innerHTML =
        '<div class="dr-error">Could not load reference article.</div>';
    }
  }

  async function applyTranslation() {
    const lang = document.getElementById('drCompareLang').value;
    if (!state.reference || !state.draft) return;
    if (lang === 'original') {
      state.displayLang = 'original';
      state.translated = null;
      renderCompare();
      return;
    }
    const cacheKey = String(state.reference.id) + ':' + lang;
    if (translateCache.has(cacheKey)) {
      state.translated = translateCache.get(cacheKey);
      state.displayLang = lang;
      renderCompare();
      return;
    }

    const btn = document.getElementById('drCompareTranslate');
    btn.disabled = true;
    btn.textContent = 'Translating…';
    try {
      const texts = [
        state.reference.title || '',
        state.reference.content || '',
        state.draft.title || '',
        state.draft.content || '',
      ];
      const res = await fetch('/admin/api/duplicate-review/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: texts, targetLang: lang, sourceLang: 'auto' }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error('fail');
      const t = data.translations || [];
      state.translated = {
        refTitle: t[0] || texts[0],
        refContent: t[1] || texts[1],
        draftTitle: t[2] || texts[2],
        draftContent: t[3] || texts[3],
      };
      translateCache.set(cacheKey, state.translated);
      state.displayLang = lang;
      renderCompare();
    } catch (e) {
      alert('Translation failed. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Apply';
    }
  }

  window.DuplicateReviewUI = {
    showWarning: showWarning,
    closeAll: closeAll,
  };
})(window);
