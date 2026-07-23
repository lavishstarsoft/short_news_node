'use strict';

/**
 * AI Insights — Duplicate News Insights (Super Admin only).
 * Reads precomputed groups. Never runs heavy AI on page render.
 */

const {
  isAiInsightsEnabled,
  createDashboardService,
  createScanService,
} = require('../services/aiInsights');

const dashboard = createDashboardService();
const scanService = createScanService();

function requireInsightsSuperAdmin(req, res) {
  if (!req.admin || req.admin.role !== 'superadmin') {
    res.status(403).send('Access denied. Super admin only.');
    return false;
  }
  if (!isAiInsightsEnabled()) {
    // Soft gate: page can still explain disabled state for superadmin
    return true;
  }
  return true;
}

async function renderDuplicateInsightsPage(req, res) {
  try {
    if (!req.admin || req.admin.role !== 'superadmin') {
      return res.status(403).send('Access denied. Super admin only.');
    }

    const enabled = isAiInsightsEnabled();
    let overview = {
      cards: {
        totalLiveNews: 0,
        duplicateGroups: 0,
        similarArticles: 0,
        averageSimilarity: 0,
        highestSimilarity: 0,
        todaysGroups: 0,
        thisWeekGroups: 0,
        embeddingCoverage: 0,
      },
      lastScan: null,
      disclaimer:
        'These articles are semantically similar. This is editorial intelligence only — not a verdict. Final decision is always human.',
      featureEnabled: enabled,
      scanEnabled: false,
    };
    let people = { subEditors: [], reporters: [] };
    let trend = { labels: [], groupCounts: [] };
    let distribution = { '85-90': 0, '90-95': 0, '95-100': 0, other: 0 };
    let groupsPayload = { total: 0, page: 1, limit: 20, groups: [] };

    if (enabled) {
      [overview, people, trend, distribution, groupsPayload] = await Promise.all([
        dashboard.getOverviewCards(),
        dashboard.getPeopleAnalytics(),
        dashboard.getTrendSeries(14),
        dashboard.getSimilarityDistribution(),
        dashboard.listGroups({ page: 1, limit: 20 }),
      ]);
    } else {
      // Still show coverage so ops know embeddings status
      try {
        overview = await dashboard.getOverviewCards();
        overview.featureEnabled = false;
      } catch (_) {
        /* ignore */
      }
    }

    res.render('ai-insights-duplicate', {
      title: 'Duplicate News Insights',
      activePage: 'ai-insights-duplicate',
      overview,
      people,
      trend,
      distribution,
      groupsPayload,
      featureEnabled: enabled,
    });
  } catch (error) {
    console.error('[AI Insights] render page error', error);
    res.status(500).send('Failed to load AI Insights');
  }
}

async function renderGroupDetailPage(req, res) {
  try {
    if (!req.admin || req.admin.role !== 'superadmin') {
      return res.status(403).send('Access denied. Super admin only.');
    }
    if (!isAiInsightsEnabled()) {
      return res.status(503).send('AI Insights is disabled (AI_INSIGHTS_ENABLED).');
    }

    const detail = await dashboard.getGroupDetail(req.params.id);
    if (!detail) {
      return res.status(404).send('Group not found');
    }

    res.render('ai-insights-group-detail', {
      title: `Group #${detail.groupNumber}`,
      activePage: 'ai-insights-duplicate',
      group: detail,
    });
  } catch (error) {
    console.error('[AI Insights] group detail error', error);
    res.status(500).send('Failed to load group');
  }
}

async function apiOverview(req, res) {
  try {
    if (!req.admin || req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super admin only' });
    }
    const data = await dashboard.getOverviewCards();
    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load overview' });
  }
}

async function apiGroups(req, res) {
  try {
    if (!req.admin || req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super admin only' });
    }
    if (!isAiInsightsEnabled()) {
      return res.json({ success: true, total: 0, page: 1, limit: 20, groups: [], disabled: true });
    }
    const data = await dashboard.listGroups(req.query);
    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list groups' });
  }
}

async function apiGroupDetail(req, res) {
  try {
    if (!req.admin || req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super admin only' });
    }
    const detail = await dashboard.getGroupDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, group: detail });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load group' });
  }
}

async function apiPeople(req, res) {
  try {
    if (!req.admin || req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super admin only' });
    }
    const data = await dashboard.getPeopleAnalytics();
    res.json({ success: true, ...data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load analytics' });
  }
}

async function apiCharts(req, res) {
  try {
    if (!req.admin || req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super admin only' });
    }
    const [trend, distribution] = await Promise.all([
      dashboard.getTrendSeries(14),
      dashboard.getSimilarityDistribution(),
    ]);
    res.json({ success: true, trend, distribution });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load charts' });
  }
}

async function apiUpdateGroupStatus(req, res) {
  try {
    if (!req.admin || req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super admin only' });
    }
    const status = req.body?.status;
    const result = await dashboard.updateGroupStatus(req.params.id, status);
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'update_failed' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update status' });
  }
}

async function apiTriggerScan(req, res) {
  try {
    if (!req.admin || req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super admin only' });
    }
    // Manual scan allowed for superadmin even if schedule flag is off (force)
    const result = await scanService.runFullScan({
      trigger: 'manual',
      force: true,
      triggeredBy: req.admin.username || req.admin.id || 'superadmin',
    });
    if (!result.ok && result.reason === 'already_running') {
      return res.status(409).json({ success: false, ...result });
    }
    res.json({ success: !!result.ok, ...result });
  } catch (error) {
    console.error('[AI Insights] manual scan error', error);
    res.status(500).json({ error: 'Scan failed' });
  }
}

module.exports = {
  requireInsightsSuperAdmin,
  renderDuplicateInsightsPage,
  renderGroupDetailPage,
  apiOverview,
  apiGroups,
  apiGroupDetail,
  apiPeople,
  apiCharts,
  apiUpdateGroupStatus,
  apiTriggerScan,
};
