'use strict';

/**
 * Background scan orchestrator for AI Duplicate Insights.
 * Node owns all Mongo writes. Python is not called here —
 * uses precomputed READY embeddings from news_vectors.
 * Atlas vector search preferred when available; windowed cosine fallback.
 */

const mongoose = require('mongoose');
const { STATUS, DEFAULT_EMBEDDING_VERSION } = require('../aiDuplicate/semantic/constants');
const { createVectorSearchService } = require('../aiDuplicate/semantic/vectorSearchService');
const { loadInsightsConfig } = require('./flags');
const {
  buildWindowedEdges,
  clusterFromEdges,
  buildGroupDraft,
} = require('./groupBuilder');
const { enrichNewsActors } = require('./enrichment');
const C = require('./constants');
const { filterDraftsAgainstDismissed } = require('./groupStatusLogic');

function createScanService(deps = {}) {
  const News = deps.News || require('../../models/News');
  const NewsVector = deps.NewsVector || require('../../models/NewsVector');
  const Admin = deps.Admin || require('../../models/Admin');
  const AiDuplicateGroup =
    deps.AiDuplicateGroup || require('../../models/AiDuplicateGroup');
  const AiDuplicateScanRun =
    deps.AiDuplicateScanRun || require('../../models/AiDuplicateScanRun');
  const AiDuplicateDailyMetric =
    deps.AiDuplicateDailyMetric || require('../../models/AiDuplicateDailyMetric');
  const vectorSearch =
    deps.vectorSearch || createVectorSearchService({ NewsVector });
  const getConfig = deps.getConfig || (() => loadInsightsConfig(deps.env || process.env));
  const log = deps.log || console;

  async function computeCoverage() {
    const [liveNewsCount, readyVectorCount] = await Promise.all([
      News.countDocuments({ isActive: true }),
      NewsVector.countDocuments({ status: STATUS.READY, isActive: true }),
    ]);
    const coveragePercent =
      liveNewsCount > 0
        ? Math.round((readyVectorCount / liveNewsCount) * 1000) / 10
        : 0;
    return { liveNewsCount, readyVectorCount, coveragePercent };
  }

  async function loadArticlesForLanguage(language, config) {
    const vectors = await NewsVector.find({
      status: STATUS.READY,
      isActive: true,
      language,
      embeddingVersion: DEFAULT_EMBEDDING_VERSION,
    })
      .select('newsId embedding publishedAt language')
      .sort({ publishedAt: -1 })
      .limit(config.maxArticlesPerLanguage)
      .lean();

    if (!vectors.length) return [];

    const newsIds = vectors.map((v) => v.newsId);
    const newsDocs = await News.find({
      _id: { $in: newsIds },
      isActive: true,
    })
      .select(
        'title author authorId publishedAt language approvalStatus actionHistory'
      )
      .lean();

    const newsById = new Map(newsDocs.map((n) => [String(n._id), n]));
    const authorIds = [
      ...new Set(
        newsDocs.map((n) => (n.authorId != null ? String(n.authorId) : null)).filter(Boolean)
      ),
    ];
    const admins = authorIds.length
      ? await Admin.find({ _id: { $in: authorIds } })
          .select('username role')
          .lean()
      : [];
    const adminById = new Map(admins.map((a) => [String(a._id), a]));

    const articles = [];
    for (const v of vectors) {
      const news = newsById.get(String(v.newsId));
      if (!news) continue;
      if (!Array.isArray(v.embedding) || !v.embedding.length) continue;
      const actors = enrichNewsActors(news, adminById);
      articles.push({
        newsId: news._id,
        embedding: v.embedding,
        publishedAt: news.publishedAt || v.publishedAt,
        language: (news.language || language || 'te').toLowerCase(),
        headline: news.title || '',
        ...actors,
      });
    }
    return articles;
  }

  async function collectAtlasEdges(articles, config) {
    const edges = [];
    let used = 0;
    let failed = 0;

    // Cap Atlas calls for safety — newest first
    const sample = [...articles]
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, Math.min(articles.length, 500));

    for (const article of sample) {
      try {
        const result = await vectorSearch.searchSimilar({
          embedding: article.embedding,
          language: article.language,
          embeddingVersion: DEFAULT_EMBEDDING_VERSION,
          windowHours: config.atlasWindowHours,
          topK: config.atlasTopK,
          excludeNewsId: String(article.newsId),
        });
        if (!result.ok) {
          failed += 1;
          continue;
        }
        used += 1;
        for (const match of result.matches || []) {
          if (match.score >= config.minSimilarity) {
            edges.push({
              a: String(article.newsId),
              b: String(match.newsId),
              score: match.score,
            });
          }
        }
      } catch (_) {
        failed += 1;
      }
    }

    return { edges, used, failed };
  }

  async function nextGroupNumber() {
    const last = await AiDuplicateGroup.findOne({})
      .sort({ groupNumber: -1 })
      .select('groupNumber')
      .lean();
    return (last?.groupNumber || 100) + 1;
  }

  async function persistGroups(drafts, scanRunId, config) {
    // Replace open/reviewed groups for this scan (keep ignored/archived).
    await AiDuplicateGroup.deleteMany({
      status: { $in: [C.GROUP_STATUS.OPEN, C.GROUP_STATUS.REVIEWED] },
    });

    const dismissed = await AiDuplicateGroup.find({
      status: { $in: [C.GROUP_STATUS.IGNORED, C.GROUP_STATUS.ARCHIVED] },
    })
      .select('memberNewsIds members status')
      .lean();

    const { kept, suppressed } = filterDraftsAgainstDismissed(drafts || [], dismissed);

    let groupNumber = await nextGroupNumber();
    const docs = kept.map((draft) => {
      const doc = {
        ...draft,
        groupNumber: groupNumber++,
        status: C.GROUP_STATUS.OPEN,
        scanRunId,
        embeddingVersion: DEFAULT_EMBEDDING_VERSION,
      };
      return doc;
    });

    if (docs.length) {
      await AiDuplicateGroup.insertMany(docs, { ordered: false });
    }
    return { groupsCreated: docs.length, groupsSuppressed: suppressed };
  }

  async function upsertDailyMetrics(coverage, openStats) {
    const now = new Date();
    const dateKey = now.toISOString().slice(0, 10);
    await AiDuplicateDailyMetric.findOneAndUpdate(
      { dateKey },
      {
        $set: {
          liveNewsCount: coverage.liveNewsCount,
          readyVectorCount: coverage.readyVectorCount,
          coveragePercent: coverage.coveragePercent,
          openGroupCount: openStats.openGroupCount,
          similarArticleCount: openStats.similarArticleCount,
          averageSimilarityPercent: openStats.averageSimilarityPercent,
          highestSimilarityPercent: openStats.highestSimilarityPercent,
        },
        $inc: { groupsCreatedThatDay: openStats.openGroupCount },
      },
      { upsert: true }
    );
  }

  async function summarizeOpenGroups() {
    const groups = await AiDuplicateGroup.find({ status: C.GROUP_STATUS.OPEN })
      .select('similarCount highestSimilarityPercent averageSimilarityPercent')
      .lean();
    if (!groups.length) {
      return {
        openGroupCount: 0,
        similarArticleCount: 0,
        averageSimilarityPercent: 0,
        highestSimilarityPercent: 0,
      };
    }
    const similarArticleCount = groups.reduce((s, g) => s + (g.similarCount || 0), 0);
    const avg =
      groups.reduce((s, g) => s + (g.averageSimilarityPercent || 0), 0) / groups.length;
    const highest = Math.max(...groups.map((g) => g.highestSimilarityPercent || 0));
    return {
      openGroupCount: groups.length,
      similarArticleCount,
      averageSimilarityPercent: Math.round(avg * 10) / 10,
      highestSimilarityPercent: highest,
    };
  }

  /**
   * Full scan entrypoint. Safe to call from worker or manual API.
   */
  async function runFullScan(options = {}) {
    const config = getConfig();
    if (!config.scanEnabled && !options.force) {
      return { ok: false, reason: 'scan_disabled' };
    }

    const running = await AiDuplicateScanRun.findOne({ status: 'running' }).lean();
    if (running && !options.force) {
      return { ok: false, reason: 'already_running', scanRunId: running._id };
    }

    const coverage = await computeCoverage();
    const scan = await AiDuplicateScanRun.create({
      status: 'running',
      trigger: options.trigger || 'schedule',
      startedAt: new Date(),
      liveNewsCount: coverage.liveNewsCount,
      readyVectorCount: coverage.readyVectorCount,
      coveragePercent: coverage.coveragePercent,
      minSimilarity: config.minSimilarity,
      compareWindowHours: config.compareWindowHours,
      triggeredBy: options.triggeredBy || null,
    });

    const started = Date.now();
    let method = 'none';
    let edgesFound = 0;
    let articlesScanned = 0;
    const languagesProcessed = [];

    try {
      const languages = await NewsVector.distinct('language', {
        status: STATUS.READY,
        isActive: true,
      });

      const allDrafts = [];
      let atlasUsed = false;
      let cosineUsed = false;

      for (const language of languages) {
        const lang = String(language || 'te').toLowerCase();
        const articles = await loadArticlesForLanguage(lang, config);
        if (articles.length < 2) continue;

        languagesProcessed.push(lang);
        articlesScanned += articles.length;
        const articleById = new Map(articles.map((a) => [String(a.newsId), a]));
        const newsIds = articles.map((a) => String(a.newsId));

        let edges = [];

        if (config.preferAtlas) {
          const atlas = await collectAtlasEdges(articles, config);
          if (atlas.used > 0 && atlas.edges.length) {
            edges = atlas.edges;
            atlasUsed = true;
          }
        }

        // Always run windowed cosine as primary or fill — production-safe without Atlas index
        const local = buildWindowedEdges(articles, {
          minSimilarity: config.minSimilarity,
          compareWindowHours: config.compareWindowHours,
        });
        if (local.edges.length) {
          cosineUsed = true;
          // Merge edges keeping max score
          const map = new Map();
          for (const e of [...edges, ...local.edges]) {
            const key = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
            const prev = map.get(key);
            if (!prev || e.score > prev.score) map.set(key, e);
          }
          edges = [...map.values()];
        }

        edgesFound += edges.length;
        const { components, pairScores } = clusterFromEdges(newsIds, edges);
        for (const component of components) {
          const draft = buildGroupDraft(component, articleById, pairScores);
          if (draft) allDrafts.push(draft);
        }
      }

      if (atlasUsed && cosineUsed) method = 'mixed';
      else if (atlasUsed) method = 'atlas';
      else if (cosineUsed) method = 'windowed_cosine';
      else method = 'none';

      const persistResult = await persistGroups(allDrafts, scan._id, config);
      const groupsCreated = persistResult.groupsCreated || 0;
      const groupsSuppressed = persistResult.groupsSuppressed || 0;
      const openStats = await summarizeOpenGroups();
      await upsertDailyMetrics(coverage, openStats);

      const durationMs = Date.now() - started;
      await AiDuplicateScanRun.findByIdAndUpdate(scan._id, {
        status: 'completed',
        finishedAt: new Date(),
        durationMs,
        languagesProcessed,
        articlesScanned,
        edgesFound,
        groupsCreated,
        groupsReplaced: groupsCreated,
        method,
        coveragePercent: coverage.coveragePercent,
      });

      log.info?.('[AI Insights] scan completed', {
        groupsCreated,
        groupsSuppressed,
        articlesScanned,
        edgesFound,
        method,
        durationMs,
      });

      return {
        ok: true,
        scanRunId: scan._id,
        groupsCreated,
        groupsSuppressed,
        articlesScanned,
        edgesFound,
        method,
        durationMs,
        coverage,
      };
    } catch (err) {
      const message = err && err.message ? err.message : 'scan_failed';
      await AiDuplicateScanRun.findByIdAndUpdate(scan._id, {
        status: 'failed',
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        error: message,
        languagesProcessed,
        articlesScanned,
        edgesFound,
        method,
      });
      log.error?.('[AI Insights] scan failed', message);
      return { ok: false, reason: 'exception', error: message, scanRunId: scan._id };
    }
  }

  return {
    runFullScan,
    computeCoverage,
    summarizeOpenGroups,
  };
}

module.exports = {
  createScanService,
};
