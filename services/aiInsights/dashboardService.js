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
        statusChangedAt: g.statusChangedAt || null,
        statusChangedBy: g.statusChangedBy || null,
        statusChangeReason: g.statusChangeReason || null,
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
      statusChangedAt: g.statusChangedAt || null,
      statusChangedBy: g.statusChangedBy || null,
      statusChangeReason: g.statusChangeReason || null,
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

  async function updateGroupStatus(groupId, status, actor = null) {
    const allowed = [
      C.GROUP_STATUS.OPEN,
      C.GROUP_STATUS.IGNORED,
      C.GROUP_STATUS.ARCHIVED,
      C.GROUP_STATUS.REVIEWED,
    ];
    if (!allowed.includes(status)) {
      return { ok: false, error: 'invalid_status' };
    }
    const reason =
      status === C.GROUP_STATUS.IGNORED
        ? 'ignored'
        : status === C.GROUP_STATUS.ARCHIVED
          ? 'archived'
          : status === C.GROUP_STATUS.OPEN
            ? 'restored'
            : 'reviewed';
    const updated = await AiDuplicateGroup.findByIdAndUpdate(
      groupId,
      {
        $set: {
          status,
          statusChangedBy: actor || null,
          statusChangedAt: new Date(),
          statusChangeReason: reason,
        },
      },
      { new: true }
    ).lean();
    if (!updated) return { ok: false, error: 'not_found' };
    return { ok: true, group: updated };
  }

  async function countGroupsByStatus() {
    const rows = await AiDuplicateGroup.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const counts = {
      open: 0,
      ignored: 0,
      archived: 0,
      reviewed: 0,
    };
    for (const row of rows) {
      if (row && row._id && Object.prototype.hasOwnProperty.call(counts, row._id)) {
        counts[row._id] = row.count;
      }
    }
    return counts;
  }

  function serializeArticle(doc, memberMeta = null) {
    if (!doc) return null;
    const imageUrls = Array.isArray(doc.imageUrls)
      ? doc.imageUrls.filter(Boolean)
      : [];
    const status = doc.rejectionStatus?.isRejected
      ? 'Rejected'
      : doc.isActive
        ? 'Published'
        : 'Pending';
    const dup = doc.duplicateCheck || {};
    return {
      id: String(doc._id),
      title: doc.title || '',
      content: doc.content || '',
      reporter: (memberMeta && memberMeta.reporterName) || doc.author || '—',
      reporterId: (memberMeta && memberMeta.reporterId) || doc.authorId || null,
      subEditor: (memberMeta && memberMeta.subEditorName) || null,
      language: doc.language || (memberMeta && memberMeta.language) || null,
      category: doc.category || null,
      location: doc.location || null,
      scope: doc.scope || null,
      state: null,
      district: doc.scope === 'district' ? doc.location || null : null,
      constituency: doc.authorConstituency || null,
      createdAt: doc.createdAt || doc.publishedAt || null,
      updatedAt: doc.updatedAt || null,
      publishedAt: doc.publishedAt || null,
      status,
      isActive: doc.isActive !== false,
      similarityPercent:
        memberMeta && memberMeta.similarityPercent != null
          ? memberMeta.similarityPercent
          : memberMeta && memberMeta.role === C.MEMBER_ROLE.ORIGINAL
            ? 100
            : null,
      role: (memberMeta && memberMeta.role) || null,
      timeDiffLabel: (memberMeta && memberMeta.timeDiffLabel) || null,
      timeDiffHuman: (memberMeta && memberMeta.timeDiffHuman) || null,
      featuredImage: doc.mediaUrl || doc.imageUrl || doc.thumbnailUrl || imageUrls[0] || null,
      mediaType: doc.mediaType || (doc.videoUrl ? 'video' : 'image'),
      mediaUrl: doc.mediaUrl || null,
      thumbnailUrl: doc.thumbnailUrl || null,
      videoUrl: doc.videoUrl || null,
      imageUrls,
      aiMetadata: {
        duplicateScore: dup.score != null ? dup.score : null,
        isDuplicate: dup.isDuplicate === true,
        isSuspicious: dup.isSuspicious === true,
        matchSource: dup.matchSource || null,
        reasonLabel: dup.reasonLabel || null,
        reasonMessage: dup.reasonMessage || null,
        checkedAt: dup.checkedAt || null,
        contentHash: doc.contentHash || null,
        mediaFingerprintStatus:
          (doc.mediaFingerprint && doc.mediaFingerprint.status) || null,
      },
    };
  }

  /**
   * Side-by-side compare payload for Insights UI.
   * Reads stored group similarity + live News docs. Does NOT run FAISS/matching.
   */
  async function getComparePair(groupId, leftId, rightId) {
    if (!groupId || !leftId || !rightId) {
      return { ok: false, error: 'missing_params' };
    }
    const g = await AiDuplicateGroup.findById(groupId).lean();
    if (!g) return { ok: false, error: 'group_not_found' };

    const members = (g.members || []).map(decorateMember);
    const memberIds = new Set(members.map((m) => String(m.newsId)));
    const leftKey = String(leftId);
    const rightKey = String(rightId);
    if (!memberIds.has(leftKey) || !memberIds.has(rightKey)) {
      return { ok: false, error: 'ids_not_in_group' };
    }

    const leftMeta = members.find((m) => String(m.newsId) === leftKey) || null;
    const rightMeta = members.find((m) => String(m.newsId) === rightKey) || null;

    const docs = await News.find({ _id: { $in: [leftKey, rightKey] } })
      .select(
        'title content author authorId category location scope language publishedAt createdAt updatedAt isActive mediaUrl mediaType thumbnailUrl imageUrl imageUrls videoUrl authorConstituency contentHash duplicateCheck mediaFingerprint rejectionStatus'
      )
      .lean();

    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const leftDoc = byId.get(leftKey);
    const rightDoc = byId.get(rightKey);
    if (!leftDoc || !rightDoc) {
      return { ok: false, error: 'article_not_found' };
    }

    const originalMeta =
      members.find((m) => m.role === C.MEMBER_ROLE.ORIGINAL) || leftMeta;
    const originalId = originalMeta ? String(originalMeta.newsId) : leftKey;
    const duplicateMeta =
      members.find(
        (m) =>
          m.role === C.MEMBER_ROLE.SIMILAR &&
          (String(m.newsId) === leftKey || String(m.newsId) === rightKey)
      ) || rightMeta;
    const duplicateId = duplicateMeta ? String(duplicateMeta.newsId) : rightKey;

    const pairSimilarity =
      duplicateMeta?.similarityPercent != null
        ? duplicateMeta.similarityPercent
        : g.highestSimilarityPercent || null;

    return {
      ok: true,
      group: {
        id: String(g._id),
        groupNumber: g.groupNumber,
        language: g.language,
        status: g.status,
        highestSimilarityPercent: g.highestSimilarityPercent,
        averageSimilarityPercent: g.averageSimilarityPercent,
        advisoryNote: g.advisoryNote || C.ADVISORY_DISCLAIMER,
      },
      pairSimilarityPercent: pairSimilarity,
      original: serializeArticle(byId.get(originalId), originalMeta),
      duplicate: serializeArticle(byId.get(duplicateId), duplicateMeta),
      left: serializeArticle(leftDoc, leftMeta),
      right: serializeArticle(rightDoc, rightMeta),
    };
  }

  return {
    getOverviewCards,
    getTrendSeries,
    getPeopleAnalytics,
    getSimilarityDistribution,
    listGroups,
    getGroupDetail,
    updateGroupStatus,
    countGroupsByStatus,
    getComparePair,
  };
}

module.exports = {
  createDashboardService,
};
