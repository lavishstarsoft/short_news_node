'use strict';

const crypto = require('crypto');
const Admin = require('../models/Admin');
const { runDuplicateCheckGateway } = require('../services/aiDuplicate/runDuplicateCheckGateway');
const { enrichSimilarArticlesFromDb } = require('../services/aiDuplicate/enrichSimilarArticles');

/**
 * Reporter PRE-SUBMIT similar-news check — powers the app's "Confirm" screen.
 *
 * Reuses the EXACT engine the admin pending page uses
 * (exact hash → fast text similarity → AI/semantic + image, with automatic
 * legacy fallback), so the reporter sees the same matches the desk will see.
 * READ-ONLY: never writes News.
 *
 * Fast by design:
 *  • 60 s result cache per reporter + text (the app pre-warms while typing,
 *    so the submit tap usually hits the cache → instant)
 *  • in-flight de-dupe (double tap → one engine run)
 *  • hard timeout (REPORTER_DUP_TIMEOUT_MS, default 4000 ms) → { checked:false }
 *    so a slow engine can never block a reporter from filing; the desk-side
 *    post-create check still runs as always.
 */
const numEnv = (env, k, fb) => {
  const n = parseInt(env[k], 10);
  return Number.isFinite(n) && n > 0 ? n : fb;
};
const isHttp = (u) => typeof u === 'string' && /^https?:\/\//i.test(u);

function createReporterDuplicateController(deps = {}) {
  const gateway = deps.runDuplicateCheckGateway || runDuplicateCheckGateway;
  const enrich = deps.enrichSimilarArticlesFromDb || enrichSimilarArticlesFromDb;
  const AdminModel = deps.Admin || Admin;
  const now = deps.now || (() => Date.now());
  const env = deps.env || process.env;

  const cacheTtlMs = numEnv(env, 'REPORTER_DUP_CACHE_MS', 60000);
  const timeoutMs = numEnv(env, 'REPORTER_DUP_TIMEOUT_MS', 4000);
  const maxMatches = numEnv(env, 'REPORTER_DUP_MAX_MATCHES', 5);

  const cache = new Map(); // key → { at, value }
  const inflight = new Map(); // key → Promise<value>

  const cacheKey = (reporterId, a) =>
    crypto
      .createHash('md5')
      .update([reporterId, a.language, a.title, a.content, a.imageUrls.join('|'), a.mediaUrl].join(''))
      .digest('hex');

  const unchecked = (started) => ({
    success: true,
    checked: false,
    found: false,
    isDuplicate: false,
    isSuspicious: false,
    score: 0,
    reason: null,
    matches: [],
    latencyMs: now() - started,
  });

  /** Card shape the app renders on the Confirm screen. */
  function toMatch(row) {
    const status = row.publishStatus || (row.isActive === true ? 'published' : 'not_published');
    return {
      id: row.articleId ? String(row.articleId) : '',
      title: row.articleTitle || '',
      content: row.content || '',
      imageUrl:
        row.thumbnailUrl || row.mediaUrl || (Array.isArray(row.imageUrls) && row.imageUrls[0]) || '',
      author: row.author || '',
      publishedAt: row.publishedAt || null,
      status: status === 'published' ? 'published' : status === 'rejected' ? 'rejected' : 'pending',
      score: Math.round(Number(row.similarity && row.similarity.overall) || 0),
      reason: row.reasonLabel || row.matchSource || 'Content',
    };
  }

  async function run(article) {
    const started = now();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    let out = null;
    try {
      out = await Promise.race([gateway(article, { excludeId: null, includePendingCorpus: true }), timeout]);
    } catch (_) {
      out = null;
    } finally {
      clearTimeout(timer);
    }
    if (!out || !out.duplicateCheck) return unchecked(started);

    const dc = out.duplicateCheck;
    let rows = Array.isArray(dc.similarArticles) ? dc.similarArticles : [];
    try {
      rows = await enrich(rows);
    } catch (_) {
      /* keep un-enriched rows */
    }

    // Rejected news is not "already published" → drop; de-dupe by id keeping
    // the strongest score; strongest first; cap for the swipe deck.
    const byId = new Map();
    for (const row of rows) {
      const m = toMatch(row);
      if (!m.id || m.status === 'rejected' || !(m.title || m.content)) continue;
      const prev = byId.get(m.id);
      if (!prev || m.score > prev.score) byId.set(m.id, m);
    }
    const matches = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, maxMatches);

    const flagged = dc.isDuplicate === true || dc.isSuspicious === true;
    return {
      success: true,
      checked: true,
      found: flagged && matches.length > 0,
      isDuplicate: dc.isDuplicate === true,
      isSuspicious: dc.isSuspicious === true,
      score: Number(dc.score) || 0,
      reason: dc.reasonLabel || null,
      matches,
      latencyMs: now() - started,
    };
  }

  /** POST /admin/api/reporter/news/similar */
  async function similarNews(req, res) {
    try {
      const reporterId = req.admin && req.admin.id;
      if (!reporterId) return res.status(401).json({ success: false, error: 'Not authenticated' });

      const b = req.body || {};
      const title = String(b.title || '').trim();
      const content = String(b.content || '').trim();
      if (title.length + content.length < 10) {
        return res.json({ success: true, checked: true, found: false, isDuplicate: false, isSuspicious: false, score: 0, reason: null, matches: [] });
      }

      let language = String(b.language || '').trim().toLowerCase();
      if (!language) {
        const me = await AdminModel.findById(reporterId).select('workingLanguage').lean();
        language = String((me && me.workingLanguage) || 'te').toLowerCase();
      }

      const imageUrls = (Array.isArray(b.imageUrls) ? b.imageUrls : []).filter(isHttp).slice(0, 10);
      const mediaUrl = isHttp(b.mediaUrl) ? b.mediaUrl : '';
      const article = {
        title,
        content,
        language,
        location: String(b.location || '').trim() || null,
        imageUrls,
        mediaUrl,
        mediaType: mediaUrl ? String(b.mediaType || 'image') : '',
      };

      const key = cacheKey(String(reporterId), article);
      const hit = cache.get(key);
      if (hit && now() - hit.at < cacheTtlMs) {
        res.set('Cache-Control', 'no-store');
        return res.json({ ...hit.value, cached: true });
      }

      let p = inflight.get(key);
      if (!p) {
        p = run(article).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      const value = await p;

      if (value.checked) {
        cache.set(key, { at: now(), value });
        if (cache.size > 500) cache.delete(cache.keys().next().value); // bounded
      }
      res.set('Cache-Control', 'no-store');
      return res.json(value);
    } catch (err) {
      console.error('[reporter][similar-news] failed:', err && err.message);
      return res.status(500).json({ success: false, error: 'Could not check for similar news. Please try again.' });
    }
  }

  return { similarNews, _cache: cache };
}

const defaultController = createReporterDuplicateController();

module.exports = {
  createReporterDuplicateController,
  similarNews: defaultController.similarNews,
};
