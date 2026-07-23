'use strict';

const C = require('./constants');
const { formatPublishedParts, formatTimeDiffHuman } = require('./timeFormat');
const { STATUS } = require('../aiDuplicate/semantic/constants');
const { loadInsightsConfig } = require('./flags');

function startOfToday(timeZoneOffsetMinutes = 330) {
  const now = new Date();
  const local = new Date(now.getTime() + timeZoneOffsetMinutes * 60 * 1000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - timeZoneOffsetMinutes * 60 * 1000);
}

function createDashboardService(deps = {}) {
  const News = deps.News || require('../../models/News');
  const NewsVector = deps.NewsVector || require('../../models/NewsVector');
  const AiDuplicateGroup =
    deps.AiDuplicateGroup || require('../../models/AiDuplicateGroup');
  const AiDuplicateScanRun =
    deps.AiDuplicateScanRun || require('../../models/AiDuplicateScanRun');
  const AiDuplicateDailyMetric =
    deps.AiDuplicateDailyMetric || require('../../models/AiDuplicateDailyMetric');
  const getConfig = deps.getConfig || (() => loadInsightsConfig(deps.env || process.env));

  async function getOverviewCards() {
    const config = getConfig();
    const todayStart = startOfToday();
    const weekStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000);

    const [
      liveNewsCount,
      readyVectorCount,
      openGroups,
      todayGroups,
      weekGroups,
      lastScan,
    ] = await Promise.all([
      News.countDocuments({ isActive: true }),
      NewsVector.countDocuments({ status: STATUS.READY, isActive: true }),
      AiDuplicateGroup.find({ status: C.GROUP_STATUS.OPEN })
        .select('similarCount highestSimilarityPercent averageSimilarityPercent firstPublishedAt')
        .lean(),
      AiDuplicateGroup.countDocuments({
        status: C.GROUP_STATUS.OPEN,
        createdAt: { $gte: todayStart },
      }),
      AiDuplicateGroup.countDocuments({
        status: C.GROUP_STATUS.OPEN,
        createdAt: { $gte: weekStart },
      }),
      AiDuplicateScanRun.findOne({ status: 'completed' })
        .sort({ finishedAt: -1 })
        .lean(),
    ]);

    const similarArticles = openGroups.reduce((s, g) => s + (g.similarCount || 0), 0);
    const avg =
      openGroups.length > 0
        ? openGroups.reduce((s, g) => s + (g.averageSimilarityPercent || 0), 0) /
          openGroups.length
        : 0;
    const highest =
      openGroups.length > 0
        ? Math.max(...openGroups.map((g) => g.highestSimilarityPercent || 0))
        : 0;
    const coveragePercent =
      liveNewsCount > 0
        ? Math.round((readyVectorCount / liveNewsCount) * 1000) / 10
        : 0;

    return {
      cards: {
        totalLiveNews: liveNewsCount,
        duplicateGroups: openGroups.length,
        similarArticles,
        averageSimilarity: Math.round(avg * 10) / 10,
        highestSimilarity: highest,
        todaysGroups: todayGroups,
        thisWeekGroups: weekGroups,
        embeddingCoverage: coveragePercent,
      },
      lastScan: lastScan
        ? {
            finishedAt: lastScan.finishedAt,
            method: lastScan.method,
            groupsCreated: lastScan.groupsCreated,
            durationMs: lastScan.durationMs,
            coveragePercent: lastScan.coveragePercent,
          }
        : null,
      disclaimer: config.disclaimer,
      featureEnabled: config.enabled,
      scanEnabled: config.scanEnabled,
    };
  }

  async function getTrendSeries(days = 14) {
    const since = new Date();
    since.setDate(since.getDate() - (days - 1));
    const metrics = await AiDuplicateDailyMetric.find({
      dateKey: { $gte: since.toISOString().slice(0, 10) },
    })
      .sort({ dateKey: 1 })
      .lean();

    const groups = await AiDuplicateGroup.aggregate([
      {
        $match: {
          status: C.GROUP_STATUS.OPEN,
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const byDay = new Map(groups.map((g) => [g._id, g.count]));
    const labels = [];
    const groupCounts = [];
    for (let i = 0; i < days; i += 1) {
      const d = new Date(since);
      d.setDate(since.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      labels.push(key);
      const metric = metrics.find((m) => m.dateKey === key);
      groupCounts.push(metric?.groupsCreatedThatDay || byDay.get(key) || 0);
    }

    return { labels, groupCounts };
  }

  function accumulatePersonStats(groups, fieldId, fieldName) {
    const map = new Map();
    for (const g of groups) {
      for (const m of g.members || []) {
        if (m.role !== C.MEMBER_ROLE.SIMILAR) continue;
        const id = m[fieldId] || m[fieldName] || 'unknown';
        const name = m[fieldName] || 'Unknown';
        const key = String(id);
        if (!map.has(key)) {
          map.set(key, {
            id: key,
            name,
            highSimilarityPublications: 0,
            similaritySum: 0,
            highestSimilarity: 0,
            latestSimilarPublication: null,
            reviewRequiredCount: 0,
          });
        }
        const row = map.get(key);
        row.highSimilarityPublications += 1;
        row.similaritySum += m.similarityPercent || 0;
        row.highestSimilarity = Math.max(
          row.highestSimilarity,
          m.similarityPercent || 0
        );
        if (
          !row.latestSimilarPublication ||
          new Date(m.publishedAt) > new Date(row.latestSimilarPublication)
        ) {
          row.latestSimilarPublication = m.publishedAt;
        }
        if ((m.similarityPercent || 0) >= 92) {
          row.reviewRequiredCount += 1;
        }
      }
    }

    return [...map.values()]
      .map((r) => ({
        id: r.id,
        name: r.name,
        highSimilarityPublications: r.highSimilarityPublications,
        averageSimilarity:
          r.highSimilarityPublications > 0
            ? Math.round((r.similaritySum / r.highSimilarityPublications) * 10) / 10
            : 0,
        highestSimilarity: r.highestSimilarity,
        latestSimilarPublication: r.latestSimilarPublication,
        reviewRequiredCount: r.reviewRequiredCount,
      }))
      .sort((a, b) => b.highSimilarityPublications - a.highSimilarityPublications);
  }

  async function getPeopleAnalytics() {
    const groups = await AiDuplicateGroup.find({ status: C.GROUP_STATUS.OPEN })
      .select('members')
      .lean();
    return {
      subEditors: accumulatePersonStats(groups, 'subEditorId', 'subEditorName'),
      reporters: accumulatePersonStats(groups, 'reporterId', 'reporterName'),
    };
  }

  async function getSimilarityDistribution() {
    const groups = await AiDuplicateGroup.find({ status: C.GROUP_STATUS.OPEN })
      .select('highestSimilarityPercent')
      .lean();
    const buckets = {
      '85-90': 0,
      '90-95': 0,
      '95-100': 0,
      other: 0,
    };
    for (const g of groups) {
      const s = g.highestSimilarityPercent || 0;
      if (s >= 95) buckets['95-100'] += 1;
      else if (s >= 90) buckets['90-95'] += 1;
      else if (s >= 85) buckets['85-90'] += 1;
      else buckets.other += 1;
    }
    return buckets;
  }

  function decorateMember(m) {
    const parts = formatPublishedParts(m.publishedAt);
    return {
      ...m,
      newsId: String(m.newsId),
      publishedDate: parts.date,
      publishedTime: parts.time,
      timeDiffHuman: formatTimeDiffHuman(m.timeDiffMsFromOriginal || 0),
    };
  }

  async function listGroups(query = {}) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit, 10) || 20));
    const skip = (page - 1) * limit;
    const filter = { status: query.status || C.GROUP_STATUS.OPEN };
    if (query.language) filter.language = String(query.language).toLowerCase();

    const [total, rows] = await Promise.all([
      AiDuplicateGroup.countDocuments(filter),
      AiDuplicateGroup.find(filter)
        .sort({ highestSimilarity: -1, firstPublishedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const groups = rows.map((g) => {
      const original = (g.members || []).find((m) => m.role === C.MEMBER_ROLE.ORIGINAL);
      const similars = (g.members || []).filter((m) => m.role === C.MEMBER_ROLE.SIMILAR);
      return {
        id: String(g._id),
        groupNumber: g.groupNumber,
        language: g.language,
        status: g.status,
        similarCount: g.similarCount,
        highestSimilarityPercent: g.highestSimilarityPercent,
        averageSimilarityPercent: g.averageSimilarityPercent,
        firstPublishedAt: g.firstPublishedAt,
        lastPublishedAt: g.lastPublishedAt,
        spanLabel: formatTimeDiffHuman(g.spanMs || 0),
        original: original ? decorateMember(original) : null,
        similarsPreview: similars.slice(0, 3).map(decorateMember),
        advisoryNote: g.advisoryNote || C.ADVISORY_DISCLAIMER,
      };
    });

    return { total, page, limit, groups };
  }

  async function getGroupDetail(groupId) {
    if (!groupId) return null;
    const g = await AiDuplicateGroup.findById(groupId).lean();
    if (!g) return null;
    const members = (g.members || []).map(decorateMember);
    const original = members.find((m) => m.role === C.MEMBER_ROLE.ORIGINAL) || null;
    const similars = members.filter((m) => m.role === C.MEMBER_ROLE.SIMILAR);
    return {
      id: String(g._id),
      groupNumber: g.groupNumber,
      language: g.language,
      status: g.status,
      similarCount: g.similarCount,
      highestSimilarityPercent: g.highestSimilarityPercent,
      averageSimilarityPercent: g.averageSimilarityPercent,
      firstPublishedAt: g.firstPublishedAt,
      lastPublishedAt: g.lastPublishedAt,
      spanLabel: formatTimeDiffHuman(g.spanMs || 0),
      advisoryNote: g.advisoryNote || C.ADVISORY_DISCLAIMER,
      original,
      similars,
      members,
      timeline: original
        ? [
            {
              type: 'original',
              at: original.publishedAt,
              label: original.publishedTime,
              headline: original.headline,
            },
            ...similars.map((s) => ({
              type: 'similar',
              at: s.publishedAt,
              label: s.publishedTime,
              headline: s.headline,
              diff: s.timeDiffLabel,
              diffHuman: s.timeDiffHuman,
              score: s.similarityPercent,
            })),
          ]
        : [],
    };
  }

  async function updateGroupStatus(groupId, status) {
    const allowed = Object.values(C.GROUP_STATUS);
    if (!allowed.includes(status)) {
      return { ok: false, error: 'invalid_status' };
    }
    const updated = await AiDuplicateGroup.findByIdAndUpdate(
      groupId,
      { $set: { status } },
      { new: true }
    ).lean();
    if (!updated) return { ok: false, error: 'not_found' };
    return { ok: true, group: updated };
  }

  return {
    getOverviewCards,
    getTrendSeries,
    getPeopleAnalytics,
    getSimilarityDistribution,
    listGroups,
    getGroupDetail,
    updateGroupStatus,
  };
}

module.exports = {
  createDashboardService,
};
