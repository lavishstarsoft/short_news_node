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
    const requestedStatus = String(req.query.status || 'open').toLowerCase();
    const allowedStatus = new Set(['open', 'ignored', 'archived']);
    const listStatus = allowedStatus.has(requestedStatus) ? requestedStatus : 'open';

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
    let statusCounts = { open: 0, ignored: 0, archived: 0, reviewed: 0 };

    if (enabled) {
      [overview, people, trend, distribution, groupsPayload, statusCounts] = await Promise.all([
        dashboard.getOverviewCards(),
        dashboard.getPeopleAnalytics(),
        dashboard.getTrendSeries(14),
        dashboard.getSimilarityDistribution(),
        dashboard.listGroups({ page: 1, limit: 20, status: listStatus }),
        dashboard.countGroupsByStatus(),
      ]);
    } else {
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
      listStatus,
      statusCounts,
      statusHelp: require('../services/aiInsights/constants').GROUP_STATUS_HELP,
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
    const actor = req.admin.username || req.admin.id || 'superadmin';
    const result = await dashboard.updateGroupStatus(req.params.id, status, actor);
    if (!result.ok) {
      return res.status(400).json({ error: result.error || 'update_failed' });
    }
    res.json({ success: true, status: result.group && result.group.status });
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

/**
 * GET /admin/api/ai-insights/groups/:id/compare?left=&right=
 * Full article compare — does not run duplicate detection.
 */
async function apiCompare(req, res) {
  try {
    if (!req.admin || req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super admin only' });
    }
    const result = await dashboard.getComparePair(
      req.params.id,
      req.query.left,
      req.query.right
    );
    if (!result.ok) {
      const map = {
        missing_params: 400,
        group_not_found: 404,
        ids_not_in_group: 400,
        article_not_found: 404,
      };
      return res.status(map[result.error] || 400).json({
        success: false,
        error: result.error || 'compare_failed',
      });
    }
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('[AI Insights] compare error', error);
    return res.status(500).json({ error: 'Failed to load comparison' });
  }
}

/**
 * POST /admin/api/ai-insights/translate
 * Body: { texts: string[], targetLang: 'en'|'hi'|'te', sourceLang?: string }
 * UI-only; does not mutate articles.
 */
async function apiTranslate(req, res) {
  try {
    if (!req.admin || req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Super admin only' });
    }
    const { texts, targetLang, sourceLang } = req.body || {};
    if (!Array.isArray(texts) || !targetLang) {
      return res.status(400).json({ error: 'texts and targetLang are required' });
    }
    if (texts.length > 20) {
      return res.status(400).json({ error: 'Too many texts' });
    }
    const { translateTexts, ALLOWED } = require('../services/aiInsights/translateService');
    if (!ALLOWED.has(String(targetLang).toLowerCase())) {
      return res.status(400).json({ error: 'Unsupported language' });
    }
    const translations = await translateTexts(texts, targetLang, sourceLang || 'auto');
    return res.json({ success: true, translations, targetLang });
  } catch (error) {
    console.error('[AI Insights] translate error', error);
    return res.status(500).json({ error: 'Translation failed' });
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
  apiCompare,
  apiTranslate,
};
