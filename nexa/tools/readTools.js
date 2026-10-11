'use strict';

/**
 * TEHELKA NEXA — read-only tools (Phase 1). These only READ and REUSE existing
 * logic. No writes, no new business logic. Registered on the shared registry.
 */

const { register } = require('./registry');

function registerReadTools() {
  // Pending news awaiting approval (reuses the app's own pending definition).
  register({
    name: 'getPendingTasks',
    description: 'List pending (unapproved, not rejected) news awaiting human review.',
    autonomyLevel: 0,
    readOnly: true,
    permission: null,
    validate(input) {
      const limit = Math.min(Math.max(parseInt(input && input.limit, 10) || 50, 1), 200);
      return { ok: true, value: { limit, language: input && input.language } };
    },
    async handler({ limit, language }) {
      const News = require('../../models/News');
      const q = {
        isActive: false,
        isDeactivated: { $ne: true },
        $or: [
          { 'rejectionStatus.isRejected': { $ne: true } },
          { rejectionStatus: { $exists: false } },
        ],
      };
      if (language) q.language = language;
      const rows = await News.find(q)
        // authorId/author added (read-only) so triage can look up reporter
        // reliability via the existing getReporterReliability tool.
        .select('_id title language location publishedAt duplicateCheck aiStatus authorId author')
        .sort({ publishedAt: 1 })
        .limit(limit)
        .lean();
      return rows;
    },
  });

  // Reporter reliability (reuses the ReporterReliability collection).
  register({
    name: 'getReporterReliability',
    description: 'Read the computed reliability score/tier for a reporter.',
    autonomyLevel: 0,
    readOnly: true,
    permission: null,
    validate(input) {
      if (!input || !input.reporterId) return { ok: false, error: 'reporterId required' };
      return { ok: true, value: { reporterId: String(input.reporterId) } };
    },
    async handler({ reporterId }) {
      const ReporterReliability = require('../../models/ReporterReliability');
      return ReporterReliability.findOne({ reporterId }).lean();
    },
  });

  // Duplicate check (reuses the existing gateway — AI/semantic + legacy fallback).
  register({
    name: 'checkDuplicate',
    description: 'Run the existing duplicate/semantic check for an article (read-only).',
    autonomyLevel: 0,
    readOnly: true,
    permission: null,
    validate(input) {
      if (!input || (!input.newsId && !input.title)) {
        return { ok: false, error: 'newsId or title required' };
      }
      return { ok: true, value: input };
    },
    async handler(input) {
      const { runDuplicateCheckGateway } = require('../../services/aiDuplicate/runDuplicateCheckGateway');
      let article = input;
      if (input.newsId) {
        const News = require('../../models/News');
        const doc = await News.findById(input.newsId)
          .select('title content language location mediaUrl mediaType imageUrls thumbnailUrl videoUrl')
          .lean();
        if (!doc) throw new Error('news_not_found');
        article = doc;
      }
      const res = await runDuplicateCheckGateway(article, {
        excludeId: input.newsId || null,
        includePendingCorpus: true,
      });
      return res.duplicateCheck;
    },
  });

  // Backlog snapshot (read-only aggregation over pending news).
  register({
    name: 'getBacklog',
    description: 'Counts of pending news, overall and older than 24h.',
    autonomyLevel: 0,
    readOnly: true,
    permission: null,
    async handler() {
      const News = require('../../models/News');
      const base = {
        isActive: false,
        isDeactivated: { $ne: true },
        $or: [
          { 'rejectionStatus.isRejected': { $ne: true } },
          { rejectionStatus: { $exists: false } },
        ],
      };
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [total, older, oldest] = await Promise.all([
        News.countDocuments(base),
        News.countDocuments({ ...base, publishedAt: { $lt: dayAgo } }),
        News.findOne(base).sort({ publishedAt: 1 }).select('publishedAt').lean(),
      ]);
      return { total, olderThan24h: older, oldestPendingAt: oldest && oldest.publishedAt };
    },
  });
}

module.exports = { registerReadTools };
