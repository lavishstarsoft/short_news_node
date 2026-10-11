'use strict';

/**
 * Semantic DECISION layer ("Meaning + shared Facts") + Layer-0 exact-hash guard.
 *
 * Why this exists: the Atlas `$vectorSearch` pipeline never runs on the
 * self-hosted Mongo (no Atlas Search), so 65k stored e5 embeddings were never
 * searched and semantic stayed advisory-only. This module does the search in
 * Node (brute-force cosine over the recent same-language window — ~1–4k
 * vectors, a few ms) and turns it into a *precision-first* decision:
 *
 *   meaning alone is NOT enough (Sydney vs Cape Town airport stories score
 *   0.86–0.92 semantically). A match is a duplicate only when the two texts
 *   also share the specific FACTS (numbers, names, places — IDF-weighted rare
 *   tokens), or when meaning is near-verbatim (>= strong).
 *
 * Calibrated on 72h of live data (2026-09-11):
 *   duplicate  : sem >= 0.95  |  sem >= 0.92 && facts >= 0.40
 *   suspicious : sem >= 0.92 && facts >= 0.30  |  sem >= 0.90 && facts >= 0.45
 *   otherwise  : nothing (this is where the "same topic, different event"
 *                pairs live — never flag them)
 *
 * Everything is gated by AI_SEMANTIC_DECISIVE (default OFF) and optionally
 * AI_SEMANTIC_DECISIVE_LANGS (csv). Layer-0 exact-hash guard is gated by
 * AI_EXACT_GUARD (default OFF). Never throws; never touches the DB on its own.
 */

const C = require('./constants');
const { loadAiConfig } = require('../config');
const { tokenizeForSimilarity } = require('../../../utils/similarityDetector');

const DEFAULTS = Object.freeze({
  DUP_STRONG: 0.95,
  DUP_SCORE: 0.92,
  DUP_FACT: 0.4,
  SUS_SCORE: 0.92,
  SUS_FACT: 0.3,
  SUS2_SCORE: 0.9,
  SUS2_FACT: 0.45,
  MIN_SEM: 0.9, // below this we don't even compute facts
  WINDOW_HOURS: 72,
  MAX_CANDIDATES: 6000,
  TOP_K: 5,
  CACHE_MS: 60 * 1000,
  EMBED_TIMEOUT_MS: 5000,
  EXACT_WINDOW_HOURS: 48,
  CONTENT_CHARS: 600,
});

function parseBool(raw) {
  return raw === 'true' || raw === '1' || raw === 'yes';
}
function parseNum(raw, fb) {
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fb;
}

function loadDecisionFlags(env = process.env) {
  const langs = String(env.AI_SEMANTIC_DECISIVE_LANGS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    enabled: parseBool(env.AI_SEMANTIC_DECISIVE),
    langs: new Set(langs), // empty = all languages
    exactGuard: parseBool(env.AI_EXACT_GUARD),
  };
}

function isDecisiveFor(language, env = process.env) {
  const f = loadDecisionFlags(env);
  if (!f.enabled) return false;
  if (f.langs.size === 0) return true;
  return f.langs.has(String(language || '').toLowerCase());
}

function loadThresholds(env = process.env) {
  return {
    dupStrong: parseNum(env.AI_SEMANTIC_DUP_STRONG, DEFAULTS.DUP_STRONG),
    dupScore: parseNum(env.AI_SEMANTIC_DUP_SCORE, DEFAULTS.DUP_SCORE),
    dupFact: parseNum(env.AI_SEMANTIC_DUP_FACT, DEFAULTS.DUP_FACT),
    susScore: parseNum(env.AI_SEMANTIC_SUS_SCORE, DEFAULTS.SUS_SCORE),
    susFact: parseNum(env.AI_SEMANTIC_SUS_FACT, DEFAULTS.SUS_FACT),
    sus2Score: parseNum(env.AI_SEMANTIC_SUS2_SCORE, DEFAULTS.SUS2_SCORE),
    sus2Fact: parseNum(env.AI_SEMANTIC_SUS2_FACT, DEFAULTS.SUS2_FACT),
    minSem: parseNum(env.AI_SEMANTIC_MIN_SEM, DEFAULTS.MIN_SEM),
    windowHours: parseNum(env.AI_SEMANTIC_WINDOW_HOURS, DEFAULTS.WINDOW_HOURS),
    maxCandidates: parseNum(env.AI_SEMANTIC_MAX_CANDIDATES, DEFAULTS.MAX_CANDIDATES),
    topK: parseNum(env.AI_SEMANTIC_TOP_K, DEFAULTS.TOP_K),
    exactWindowHours: parseNum(env.AI_EXACT_GUARD_WINDOW_HOURS, DEFAULTS.EXACT_WINDOW_HOURS),
  };
}

// ---------------------------------------------------------------- math
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return d / Math.sqrt(na * nb);
}

/** Fact tokens: numbers (digit-runs) + script-agnostic words >= 3 chars. */
function factTokens(title, content, contentChars = DEFAULTS.CONTENT_CHARS) {
  const text = `${title || ''} ${String(content || '').slice(0, contentChars)}`;
  const out = new Set();
  const nums = text.match(/\d[\d,.]*/g) || [];
  for (const n of nums) {
    const clean = n.replace(/[,.]/g, '');
    if (clean) out.add(`#${clean}`);
  }
  let words = [];
  try {
    words = tokenizeForSimilarity(text) || [];
  } catch (_) {
    words = String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u);
  }
  for (const w of words) {
    if (w && w.length >= 3 && !/^\d+$/.test(w)) out.add(w);
  }
  return out;
}

/** IDF over a corpus of token sets: ln((N+1)/(df+1)). */
function buildIdf(tokenSets) {
  const df = new Map();
  for (const s of tokenSets) {
    for (const t of s) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = tokenSets.length;
  return (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1));
}

/** IDF-weighted containment of shared fact tokens: Σ_shared idf / min(Σ_A, Σ_B). */
function factOverlap(A, B, idf) {
  if (!A || !B || !A.size || !B.size) return 0;
  let inter = 0;
  let sa = 0;
  let sb = 0;
  for (const x of A) {
    const w = idf(x);
    sa += w;
    if (B.has(x)) inter += w;
  }
  for (const x of B) sb += idf(x);
  const denom = Math.min(sa, sb);
  return denom > 0 ? Math.max(0, Math.min(1, inter / denom)) : 0;
}

/** Number tokens only (#123) — the "which day / which figure" signal. */
function numberTokens(tokenSet) {
  const out = new Set();
  for (const x of tokenSet) if (x.startsWith('#')) out.add(x);
  return out;
}
/** Jaccard over number tokens; null when either side has no numbers. */
function numberOverlap(A, B) {
  const a = numberTokens(A);
  const b = numberTokens(B);
  if (!a.size || !b.size) return null;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Recurring-template veto: identical wording but disjoint numbers = a daily
 * update (rates, weather, footfall), not a copy. Same author → not a match at
 * all; different author → at most "suspicious".
 */
function applyTemplateVeto(verdict, numOv, sameAuthor) {
  if (!verdict || numOv === null || numOv > 0) return verdict;
  if (sameAuthor) return null;
  return 'suspicious';
}

function verdictFor(sem, fact, t) {
  if (sem >= t.dupStrong) return 'duplicate';
  if (sem >= t.dupScore && fact >= t.dupFact) return 'duplicate';
  if (sem >= t.susScore && fact >= t.susFact) return 'suspicious';
  if (sem >= t.sus2Score && fact >= t.sus2Fact) return 'suspicious';
  return null;
}

function pct(x) {
  return Math.round(Math.max(0, Math.min(1, x)) * 100);
}

// ---------------------------------------------------------------- rows + merge
function buildSemanticRow(cand, sem, fact, verdict) {
  const overall = pct(sem);
  return {
    articleId: String(cand.newsId),
    articleTitle: cand.title || '',
    content: cand.content || '',
    publishedAt: cand.publishedAt || null,
    author: cand.author || null,
    isActive: cand.isActive === true,
    similarity: { title: 0, content: overall, keywords: pct(fact), overall },
    isDuplicate: verdict === 'duplicate',
    isSuspicious: verdict === 'suspicious',
    matchSource: 'content',
    matchType: 'semantic',
    reasonLabel: 'Meaning + shared facts',
    reasonMessage: `Same story written differently — meaning ${overall}%, shared facts ${pct(fact)}%.`,
    semanticScore: Number(sem.toFixed(4)),
    factScore: Number(fact.toFixed(4)),
  };
}

function buildExactRow(doc) {
  const when = doc.publishedAt ? new Date(doc.publishedAt).toISOString() : '';
  return {
    articleId: String(doc._id),
    articleTitle: doc.title || '',
    content: doc.content || '',
    publishedAt: doc.publishedAt || null,
    author: doc.author || null,
    isActive: doc.isActive === true,
    similarity: { title: 100, content: 100, keywords: 100, overall: 100 },
    isDuplicate: true,
    isSuspicious: false,
    matchSource: 'content',
    matchType: 'text_exact',
    reasonLabel: 'Exact copy',
    reasonMessage: `Identical text already exists${when ? ' (posted ' + when + ')' : ''}.`,
  };
}

/**
 * Merge decision rows into an existing duplicateCheck (legacy shape).
 * Upgrades flags/labels of rows that already exist; recomputes top-level
 * isDuplicate / isSuspicious / score / matchCount / reason. Pure.
 */
function mergeRowsIntoDuplicateCheck(duplicateCheck, rows) {
  const dc = { ...(duplicateCheck || {}) };
  const list = Array.isArray(dc.similarArticles) ? dc.similarArticles.map((r) => ({ ...r })) : [];
  if (!rows || !rows.length) {
    return dc;
  }
  for (const row of rows) {
    const id = String(row.articleId);
    const ex = list.find((r) => String(r.articleId) === id);
    if (!ex) {
      list.push({ ...row });
      continue;
    }
    ex.isDuplicate = ex.isDuplicate === true || row.isDuplicate === true;
    ex.isSuspicious = !ex.isDuplicate && (ex.isSuspicious === true || row.isSuspicious === true);
    const prev = (ex.similarity && ex.similarity.overall) || 0;
    if (row.similarity.overall > prev) ex.similarity = { ...row.similarity };
    if (ex.matchSource === 'image') {
      ex.matchSource = 'both';
      ex.reasonLabel = 'Image + Content';
      ex.reasonMessage = 'Same/similar image and similar text content were both detected.';
    } else if (!ex.reasonLabel || ex.reasonLabel === 'Content') {
      ex.reasonLabel = row.reasonLabel;
      ex.reasonMessage = row.reasonMessage;
    }
    ex.matchType = ex.matchType && ex.matchType !== 'text_near' ? ex.matchType : row.matchType;
  }
  const isDuplicate = list.some((r) => r.isDuplicate === true);
  const isSuspicious = !isDuplicate && list.some((r) => r.isSuspicious === true);
  const score = Math.max(
    typeof dc.score === 'number' ? dc.score : 0,
    ...list.map((r) => (r.similarity && r.similarity.overall) || 0)
  );
  const top = [...list].sort((a, b) => ((b.similarity && b.similarity.overall) || 0) - ((a.similarity && a.similarity.overall) || 0))[0];
  const flagged = isDuplicate || isSuspicious;
  const hasImage = list.some((r) => r.matchSource === 'image' || r.matchSource === 'both');
  const hasContent = list.some((r) => r.matchSource === 'content' || r.matchSource === 'both');
  let matchSource = dc.matchSource;
  let reasonLabel = dc.reasonLabel;
  let reasonMessage = dc.reasonMessage;
  if (flagged) {
    if (hasImage && hasContent) {
      matchSource = 'both';
      reasonLabel = 'Image + Content';
      reasonMessage = 'Same/similar image and similar text content were both detected.';
    } else if (!matchSource || matchSource === 'content' || !dc.isDuplicate) {
      matchSource = hasImage ? 'image' : 'content';
      reasonLabel = top ? top.reasonLabel : reasonLabel || 'Content';
      reasonMessage = top ? top.reasonMessage : reasonMessage || 'Similar title or text content detected.';
    }
  }
  return {
    ...dc,
    isDuplicate,
    isSuspicious,
    score,
    matchCount: list.length,
    matchSource: matchSource || null,
    reasonLabel: reasonLabel || null,
    reasonMessage: reasonMessage || null,
    similarArticles: list.slice(0, 20),
    checkedAt: new Date(),
  };
}

// ---------------------------------------------------------------- default deps
function createDefaultEmbedFn(deps = {}) {
  return async function embedText(payload = {}) {
    const env = deps.env || process.env;
    const cfg = loadAiConfig(env);
    const http = deps.http || require('axios');
    if (!cfg.baseUrl || !cfg.apiKey) return { ok: false, error: 'embed_config_missing' };
    const started = Date.now();
    try {
      const response = await http.post(
        `${cfg.baseUrl}/v1/embed`,
        { title: payload.title || '', content: payload.content || '', language: payload.language || 'te' },
        {
          timeout: parseNum(env.AI_SEMANTIC_DECISIVE_EMBED_TIMEOUT_MS, DEFAULTS.EMBED_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            'X-AI-Service-Key': cfg.apiKey,
            ...(payload.requestId ? { 'X-Request-Id': String(payload.requestId) } : {}),
          },
          validateStatus: () => true,
        }
      );
      const latencyMs = Date.now() - started;
      if (response.status < 200 || response.status >= 300) return { ok: false, error: `embed_http_${response.status}`, latencyMs };
      const data = response.data || {};
      if (!Array.isArray(data.embedding)) return { ok: false, error: 'embed_invalid_response', latencyMs };
      return { ok: true, embedding: data.embedding, embeddingVersion: data.embeddingVersion || C.DEFAULT_EMBEDDING_VERSION, latencyMs };
    } catch (err) {
      return { ok: false, error: err && err.code ? `embed_${err.code}` : 'embed_exception', latencyMs: Date.now() - started };
    }
  };
}

function createDefaultLoaders(deps = {}) {
  const getNewsVector = () => deps.NewsVector || require('../../../models/NewsVector');
  const getNews = () => deps.News || require('../../../models/News');
  return {
    /** Recent READY vectors for a language (newest first). */
    async loadWindowVectors(language, since, limit, embeddingVersion) {
      return getNewsVector()
        .find({ status: C.STATUS.READY, language, embeddingVersion, publishedAt: { $gte: since } })
        .select('newsId embedding publishedAt isActive')
        .sort({ publishedAt: -1 })
        .limit(limit)
        .lean();
    },
    /** Texts for those articles (excluding deactivated / rejected). */
    async loadNewsTexts(ids) {
      const docs = await getNews()
        .find({
          _id: { $in: ids },
          isDeactivated: { $ne: true },
          $or: [{ 'rejectionStatus.isRejected': { $ne: true } }, { rejectionStatus: { $exists: false } }],
        })
        .select('_id title content author authorId isActive publishedAt')
        .lean();
      return docs;
    },
    /** Author of the article being checked (for the same-author template veto). */
    async loadAuthorId(newsId) {
      if (!newsId) return null;
      const d = await getNews().findById(newsId).select('authorId').lean();
      return d && d.authorId != null ? String(d.authorId) : null;
    },
    /** Layer-0: identical text already exists in the recent window. */
    async findExactHash(contentHash, excludeId, since) {
      const q = {
        contentHash,
        isDeactivated: { $ne: true },
        $or: [{ 'rejectionStatus.isRejected': { $ne: true } }, { rejectionStatus: { $exists: false } }],
        publishedAt: { $gte: since },
      };
      if (excludeId) q._id = { $ne: excludeId };
      return getNews().findOne(q).select('_id title content author authorId isActive publishedAt').lean();
    },
  };
}

// ---------------------------------------------------------------- service
function createSemanticDecisionService(deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  const log = deps.log || { info() {}, warn() {}, error() {}, debug() {} };
  const embedText = deps.embedText || createDefaultEmbedFn({ env, http: deps.http });
  const loaders = { ...createDefaultLoaders(deps), ...(deps.loaders || {}) };
  const cache = new Map(); // language -> { at, items, idf, tokens }

  async function getWindow(language, t) {
    const key = language;
    const hit = cache.get(key);
    if (hit && now() - hit.at < DEFAULTS.CACHE_MS) return hit;
    const since = new Date(now() - t.windowHours * 3600 * 1000);
    const vecs = await loaders.loadWindowVectors(language, since, t.maxCandidates, C.DEFAULT_EMBEDDING_VERSION);
    const ids = vecs.map((v) => v.newsId);
    const docs = ids.length ? await loaders.loadNewsTexts(ids) : [];
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const items = [];
    const tokenSets = [];
    for (const v of vecs) {
      const d = byId.get(String(v.newsId));
      if (!d || !Array.isArray(v.embedding) || !v.embedding.length) continue;
      const tokens = factTokens(d.title, d.content);
      items.push({
        newsId: String(v.newsId),
        embedding: v.embedding,
        publishedAt: v.publishedAt || d.publishedAt || null,
        isActive: d.isActive === true,
        authorId: d.authorId != null ? String(d.authorId) : null,
        title: d.title || '',
        content: d.content || '',
        author: d.author || null,
        tokens,
      });
      tokenSets.push(tokens);
    }
    const win = { at: now(), items, idf: buildIdf(tokenSets) };
    cache.set(key, win);
    return win;
  }

  /**
   * Evaluate one article. Returns { ok, reason, rows, stats }. rows contain
   * only candidates with a verdict. Never throws.
   */
  async function evaluate(input = {}) {
    const language = String(input.language || 'te').toLowerCase();
    const started = now();
    if (!isDecisiveFor(language, env)) return { ok: false, reason: 'disabled', rows: [] };
    const t = loadThresholds(env);
    try {
      let embedding = Array.isArray(input.embedding) ? input.embedding : null;
      let embedLatencyMs = null;
      if (!embedding) {
        const e = await embedText({ title: input.title, content: input.content, language, requestId: input.requestId });
        if (!e.ok) {
          log.warn('semantic decision: embed failed', { requestId: input.requestId, error: e.error });
          return { ok: false, reason: e.error || 'embed_failed', rows: [] };
        }
        embedding = e.embedding;
        embedLatencyMs = e.latencyMs;
      }
      const win = await getWindow(language, t);
      const excludeId = input.excludeId != null ? String(input.excludeId) : null;
      const scored = [];
      for (const it of win.items) {
        if (excludeId && it.newsId === excludeId) continue;
        const s = cosine(embedding, it.embedding);
        if (s >= t.minSem) scored.push({ it, sem: s });
      }
      scored.sort((a, b) => b.sem - a.sem);
      const qTokens = factTokens(input.title, input.content);
      let qAuthor = input.authorId != null ? String(input.authorId) : null;
      if (!qAuthor && excludeId && loaders.loadAuthorId) {
        try { qAuthor = await loaders.loadAuthorId(excludeId); } catch (_) { qAuthor = null; }
      }
      const rows = [];
      let top = null;
      for (const { it, sem } of scored.slice(0, t.topK)) {
        const fact = factOverlap(qTokens, it.tokens, win.idf);
        const numOv = numberOverlap(qTokens, it.tokens);
        const sameAuthor = !!(qAuthor && it.authorId && qAuthor === it.authorId);
        const verdict = applyTemplateVeto(verdictFor(sem, fact, t), numOv, sameAuthor);
        if (!top) top = { sem, fact, numOv, sameAuthor, verdict, newsId: it.newsId };
        if (verdict) rows.push(buildSemanticRow(it, sem, fact, verdict));
      }
      const stats = { window: win.items.length, latencyMs: now() - started, embedLatencyMs, top };
      log.info('semantic decision', { requestId: input.requestId, newsId: excludeId, language, ...stats, flagged: rows.length });
      return { ok: true, reason: rows.length ? 'flagged' : 'clean', rows, stats };
    } catch (err) {
      log.warn('semantic decision: exception', { requestId: input.requestId, error: err && err.message });
      return { ok: false, reason: 'exception', rows: [] };
    }
  }

  /** Layer-0 exact copy guard. Returns a row or null. Never throws. */
  async function exactGuard(input = {}) {
    const f = loadDecisionFlags(env);
    if (!f.exactGuard || !input.contentHash) return null;
    try {
      const t = loadThresholds(env);
      const since = new Date(now() - t.exactWindowHours * 3600 * 1000);
      const doc = await loaders.findExactHash(input.contentHash, input.excludeId || null, since);
      if (!doc) return null;
      log.info('exact guard hit', { requestId: input.requestId, newsId: input.excludeId, matched: String(doc._id) });
      return buildExactRow(doc);
    } catch (err) {
      log.warn('exact guard: exception', { requestId: input.requestId, error: err && err.message });
      return null;
    }
  }

  /** Apply both layers onto a duplicateCheck. Never throws, never reduces flags. */
  async function applyLayers(duplicateCheck, ctx = {}) {
    let dc = duplicateCheck || {};
    const exact = await exactGuard(ctx);
    if (exact) dc = mergeRowsIntoDuplicateCheck(dc, [exact]);
    const sem = await evaluate(ctx);
    if (sem.ok && sem.rows.length) dc = mergeRowsIntoDuplicateCheck(dc, sem.rows);
    return dc;
  }

  return { evaluate, exactGuard, applyLayers, getWindow, clearCache: () => cache.clear() };
}

module.exports = {
  DEFAULTS,
  loadDecisionFlags,
  isDecisiveFor,
  loadThresholds,
  cosine,
  factTokens,
  buildIdf,
  factOverlap,
  verdictFor,
  numberOverlap,
  applyTemplateVeto,
  buildSemanticRow,
  buildExactRow,
  mergeRowsIntoDuplicateCheck,
  createSemanticDecisionService,
};
