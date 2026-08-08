'use strict';

/**
 * viewEngineRoutes.js — isolated admin API for the Smart View Distribution Engine.
 *
 * Mounted at /admin/view-engine (see server.js). SUPERADMIN ONLY — enforced here
 * with the existing adminController.requireSuperAdmin middleware (reused, not
 * reimplemented). requireAuth is applied at the mount point.
 *
 * Scope: the single AppSettings ON/OFF flag + minimal campaign CRUD/lifecycle.
 * Every mutating action writes to the existing AuditLog collection.
 * Touches no existing routes. Rollback endpoints live in File 12.
 */

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const AppSettings = require('../../../models/AppSettings');
const AuditLog = require('../../../models/AuditLog');
const { requireSuperAdmin } = require('../../../controllers/adminController');
const ViewCampaign = require('../models/ViewCampaign');
const ViewCycleLog = require('../models/ViewCycleLog');
const ViewEngineSettings = require('../models/ViewEngineSettings');
const { redisClient, isRedisAvailable } = require('../../../config/redis');
const config = require('../config');
const queue = require('../queue');
const ticker = require('../ticker');
const rollback = require('../rollback');
const { LOG_PREFIX } = require('../constants');

const VALID_STATUS = ['draft', 'active', 'paused', 'completed', 'cancelled', 'reversed'];
// Finite durations in minutes: 30m, 1h, 2h, 6h, 12h, 24h, 3d, 7d, 15d, 30d.
const VALID_DURATIONS = [30, 60, 120, 360, 720, 1440, 4320, 10080, 21600, 43200];
// Internal curve window used by 'unlimited' campaigns (ticker guard prevents
// completion; this only drives the delivery curve). 24h ramp, then rebalancing
// keeps discovering/boosting newly eligible news.
const UNLIMITED_CURVE_MINUTES = 1440;
const VALID_INTENSITY = ['conservative', 'balanced', 'aggressive'];
const VALID_STRATEGY = ['static', 'adaptive', 'ml'];

// Every route here is superadmin-only.
router.use(requireSuperAdmin);

// ---- helpers -----------------------------------------------------------

function actorIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || '').toString();
}

/** Best-effort audit write — never blocks the response on failure. */
async function writeAudit(req, entry) {
  try {
    await AuditLog.create({
      actorId: (req.admin && (req.admin._id || req.admin.id)) || null,
      actorName: (req.admin && req.admin.username) || '',
      actorRole: (req.admin && req.admin.role) || '',
      action: entry.action,
      entityType: entry.entityType || 'ViewCampaign',
      entityId: String(entry.entityId || ''),
      description: entry.description || '',
      before: entry.before ?? null,
      after: entry.after ?? null,
      ip: actorIp(req)
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} audit write failed:`, err.message);
  }
}

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

/** Validate + normalize a campaign create/update body. Returns {value?, errors?}. */
function validateCampaignBody(body = {}, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) errors.push('name is required');
    else out.name = body.name.trim();
  }

  // Duration + type. 'unlimited' => no durationMinutes required (internal curve window).
  if (body.durationType === 'unlimited') {
    out.durationType = 'unlimited';
    out.durationMinutes = UNLIMITED_CURVE_MINUTES;
  } else if (!partial || body.durationMinutes !== undefined || body.durationType !== undefined) {
    out.durationType = 'finite';
    const d = Number(body.durationMinutes);
    if (!VALID_DURATIONS.includes(d)) {
      errors.push('durationMinutes must be one of: ' + VALID_DURATIONS.join(', ') + ' (or durationType "unlimited")');
    } else {
      out.durationMinutes = d;
    }
  }
  if (!partial || body.minViews !== undefined) {
    const min = Number(body.minViews);
    if (!Number.isInteger(min) || min < 0) errors.push('minViews must be a non-negative integer');
    else out.minViews = min;
  }
  if (!partial || body.maxViews !== undefined) {
    const max = Number(body.maxViews);
    if (!Number.isInteger(max) || max < 0) errors.push('maxViews must be a non-negative integer');
    else out.maxViews = max;
  }
  if (out.minViews !== undefined && out.maxViews !== undefined && out.maxViews < out.minViews) {
    errors.push('maxViews must be >= minViews');
  }
  if (body.intensity !== undefined) {
    if (!VALID_INTENSITY.includes(body.intensity)) errors.push(`intensity must be one of ${VALID_INTENSITY.join(', ')}`);
    else out.intensity = body.intensity;
  }
  if (!partial || body.strategy !== undefined) {
    if (!VALID_STRATEGY.includes(body.strategy)) errors.push(`strategy must be one of ${VALID_STRATEGY.join(', ')}`);
    else out.strategy = body.strategy;
  }
  if (body.dryRun !== undefined) out.dryRun = !!body.dryRun;
  if (body.itemCap !== undefined) {
    const c = Number(body.itemCap);
    if (!Number.isInteger(c) || c < 1 || c > 100000) errors.push('itemCap must be an integer 1..100000');
    else out.itemCap = c;
  }
  if (body.rebalanceIntervalSec !== undefined) {
    const r = Number(body.rebalanceIntervalSec);
    if (!Number.isInteger(r) || r < 30 || r > 3600) errors.push('rebalanceIntervalSec must be an integer 30..3600');
    else out.rebalanceIntervalSec = r;
  }
  if (body.eligibility !== undefined && body.eligibility !== null) {
    const e = body.eligibility;
    if (typeof e !== 'object') errors.push('eligibility must be an object');
    else {
      out.eligibility = {};
      for (const k of ['languages', 'categories', 'scopes']) {
        if (e[k] !== undefined) {
          if (!Array.isArray(e[k])) errors.push(`eligibility.${k} must be an array`);
          else out.eligibility[k] = e[k].map(String);
        }
      }
      if (e.maxAgeHours !== undefined && e.maxAgeHours !== null) {
        const h = Number(e.maxAgeHours);
        if (!Number.isFinite(h) || h <= 0) errors.push('eligibility.maxAgeHours must be a positive number');
        else out.eligibility.maxAgeHours = h;
      }
    }
  }

  return errors.length ? { errors } : { value: out };
}

// ---- status ------------------------------------------------------------

router.get('/status', async (req, res) => {
  try {
    const [qstats, active, draft] = await Promise.all([
      queue.stats(),
      ViewCampaign.countDocuments({ status: 'active' }),
      ViewCampaign.countDocuments({ status: 'draft' })
    ]);
    res.json({
      success: true,
      enabled: config.isEnabledCached(),
      killed: String(process.env.VIEW_ENGINE_KILL || '').toLowerCase() === 'true',
      ticker: ticker.getMetrics(),
      queue: qstats,
      campaigns: { active, draft }
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} status error:`, err.message);
    res.status(500).json({ error: 'status_failed' });
  }
});

// ---- ON/OFF flag -------------------------------------------------------

router.put('/flag', async (req, res) => {
  const enabled = req.body && req.body.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean' });
  }
  try {
    let settings = await AppSettings.findOne({ key: 'update_flags' });
    if (!settings) settings = new AppSettings();
    const before = !!settings.viewEngineEnabled;
    settings.viewEngineEnabled = enabled;
    await settings.save();
    await config.refreshEnabled(); // update the cached flag immediately

    await writeAudit(req, {
      action: 'view_engine_flag_update',
      entityType: 'AppSettings',
      entityId: settings._id,
      description: `View Engine ${enabled ? 'ENABLED' : 'DISABLED'}`,
      before: { viewEngineEnabled: before },
      after: { viewEngineEnabled: enabled }
    });
    res.json({ success: true, enabled });
  } catch (err) {
    console.error(`${LOG_PREFIX} flag update error:`, err.message);
    res.status(500).json({ error: 'flag_update_failed' });
  }
});

// ---- campaign list / read ---------------------------------------------

router.get('/campaigns', async (req, res) => {
  try {
    const filter = {};
    if (req.query.status && VALID_STATUS.includes(req.query.status)) filter.status = req.query.status;
    const campaigns = await ViewCampaign.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ success: true, campaigns });
  } catch (err) {
    console.error(`${LOG_PREFIX} list campaigns error:`, err.message);
    res.status(500).json({ error: 'list_failed' });
  }
});

router.get('/campaigns/:id', async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const c = await ViewCampaign.findById(req.params.id).lean();
    if (!c) return res.status(404).json({ error: 'not_found' });
    res.json({ success: true, campaign: c });
  } catch (err) {
    res.status(500).json({ error: 'read_failed' });
  }
});

// ---- campaign create ---------------------------------------------------

router.post('/campaigns', async (req, res) => {
  const { value, errors } = validateCampaignBody(req.body || {});
  if (errors) return res.status(400).json({ error: 'validation_failed', errors });
  try {
    const campaign = await ViewCampaign.create({
      ...value,
      status: 'draft',
      createdBy: (req.admin && (req.admin._id || req.admin.id)) || null,
      createdByName: (req.admin && req.admin.username) || ''
    });
    await writeAudit(req, {
      action: 'view_engine_campaign_create',
      entityId: campaign._id,
      description: `Created campaign (${campaign.durationMinutes}m, ${campaign.minViews}-${campaign.maxViews})`,
      after: campaign.toObject()
    });
    res.status(201).json({ success: true, campaign });
  } catch (err) {
    console.error(`${LOG_PREFIX} create campaign error:`, err.message);
    res.status(500).json({ error: 'create_failed' });
  }
});

// ---- campaign update (draft only) -------------------------------------

router.put('/campaigns/:id', async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
  const { value, errors } = validateCampaignBody(req.body || {}, { partial: true });
  if (errors) return res.status(400).json({ error: 'validation_failed', errors });
  try {
    const campaign = await ViewCampaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'not_found' });
    if (campaign.status !== 'draft') {
      return res.status(409).json({ error: 'only draft campaigns can be edited' });
    }
    const before = campaign.toObject();
    Object.assign(campaign, value);
    await campaign.save();
    await writeAudit(req, {
      action: 'view_engine_campaign_update',
      entityId: campaign._id,
      description: 'Updated draft campaign',
      before,
      after: campaign.toObject()
    });
    res.json({ success: true, campaign });
  } catch (err) {
    console.error(`${LOG_PREFIX} update campaign error:`, err.message);
    res.status(500).json({ error: 'update_failed' });
  }
});

// ---- lifecycle: activate / pause / cancel -----------------------------

router.post('/campaigns/:id/activate', async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const campaign = await ViewCampaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'not_found' });
    if (!['draft', 'paused'].includes(campaign.status)) {
      return res.status(409).json({ error: `cannot activate a ${campaign.status} campaign` });
    }
    const before = { status: campaign.status };
    const now = new Date();
    // draft => fresh window; paused => resume keeping the original window.
    if (campaign.status === 'draft' || !campaign.startAt) {
      campaign.startAt = now;
      // Unlimited => no end time (runs until manually stopped). Finite => as today.
      campaign.endAt = campaign.durationType === 'unlimited'
        ? null
        : new Date(now.getTime() + campaign.durationMinutes * 60000);
    }
    campaign.status = 'active';
    await campaign.save();
    await writeAudit(req, {
      action: 'view_engine_campaign_activate',
      entityId: campaign._id,
      description: `Activated (${campaign.durationMinutes}m window)`,
      before,
      after: { status: 'active', startAt: campaign.startAt, endAt: campaign.endAt }
    });
    res.json({ success: true, campaign });
  } catch (err) {
    console.error(`${LOG_PREFIX} activate error:`, err.message);
    res.status(500).json({ error: 'activate_failed' });
  }
});

router.post('/campaigns/:id/pause', async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const campaign = await ViewCampaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'not_found' });
    if (campaign.status !== 'active') {
      return res.status(409).json({ error: `cannot pause a ${campaign.status} campaign` });
    }
    campaign.status = 'paused';
    await campaign.save();
    await writeAudit(req, {
      action: 'view_engine_campaign_pause',
      entityId: campaign._id,
      description: 'Paused campaign',
      before: { status: 'active' },
      after: { status: 'paused' }
    });
    res.json({ success: true, campaign });
  } catch (err) {
    console.error(`${LOG_PREFIX} pause error:`, err.message);
    res.status(500).json({ error: 'pause_failed' });
  }
});

router.post('/campaigns/:id/cancel', async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const campaign = await ViewCampaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'not_found' });
    if (['completed', 'cancelled', 'reversed'].includes(campaign.status)) {
      return res.status(409).json({ error: `campaign already ${campaign.status}` });
    }
    const before = { status: campaign.status };
    campaign.status = 'cancelled';
    await campaign.save();
    await writeAudit(req, {
      action: 'view_engine_campaign_cancel',
      entityId: campaign._id,
      description: 'Cancelled campaign',
      before,
      after: { status: 'cancelled' }
    });
    res.json({ success: true, campaign });
  } catch (err) {
    console.error(`${LOG_PREFIX} cancel error:`, err.message);
    res.status(500).json({ error: 'cancel_failed' });
  }
});

// ---- rollback: reverse synthetic views (ledger-driven, clamped) -------

router.post('/campaigns/:id/reverse', async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const result = await rollback.reverseCampaign(req.params.id);
    if (!result.ok) {
      const map = { not_found: 404, active_must_pause_first: 409 };
      return res.status(map[result.error] || 400).json({ error: result.error });
    }
    await writeAudit(req, {
      action: 'view_engine_campaign_reverse',
      entityId: req.params.id,
      description: `Reversed campaign (${result.cyclesReversed} cycle(s), -${result.totalReversed} synthetic)`,
      after: { status: 'reversed', cyclesReversed: result.cyclesReversed, totalReversed: result.totalReversed }
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`${LOG_PREFIX} reverse endpoint error:`, err.message);
    res.status(500).json({ error: 'reverse_failed' });
  }
});

// ---- delete (draft only, safety) --------------------------------------

router.delete('/campaigns/:id', async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const campaign = await ViewCampaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'not_found' });
    const before = campaign.toObject();
    await campaign.deleteOne();
    await writeAudit(req, {
      action: 'view_engine_campaign_delete',
      entityId: req.params.id,
      description: 'Deleted draft campaign',
      before
    });
    res.json({ success: true });
  } catch (err) {
    console.error(`${LOG_PREFIX} delete error:`, err.message);
    res.status(500).json({ error: 'delete_failed' });
  }
});

// ---- Settings: live metrics (read-only, real sources) -----------------

async function buildLiveMetrics() {
  const redisUp = isRedisAvailable();
  const mongoUp = require('mongoose').connection.readyState === 1;
  let leader = 'None';
  let lastHeartbeat = 'N/A';
  if (redisUp) {
    try { leader = (await redisClient.get('vde:leader')) || 'None'; } catch (_) { /* ignore */ }
    try {
      const hb = await redisClient.get('vde:heartbeat');
      if (hb) lastHeartbeat = new Date(parseInt(hb, 10)).toLocaleTimeString();
    } catch (_) { /* ignore */ }
  }
  const qStats = await queue.stats();
  let activeCampaigns = 0;
  try { activeCampaigns = await ViewCampaign.countDocuments({ status: 'active' }); } catch (_) { /* ignore */ }
  let workers = 0;
  try {
    const since = new Date(Date.now() - 15 * 60 * 1000);
    workers = (await ViewCycleLog.distinct('workerId', { createdAt: { $gte: since } })).length;
  } catch (_) { /* ignore */ }
  return {
    engineEnabled: config.isEnabledCached(),
    killed: String(process.env.VIEW_ENGINE_KILL || '').toLowerCase() === 'true',
    redis: redisUp ? 'Connected' : 'Down',
    mongo: mongoUp ? 'Connected' : 'Down',
    queue: qStats.available ? 'Healthy' : 'Degraded',
    leader,
    workers,
    queueSize: qStats.available ? (qStats.stream || 0) : 0,
    activeCampaigns,
    lastHeartbeat,
    version: '1.0.0',
    lastRestart: new Date(Date.now() - process.uptime() * 1000).toLocaleString()
  };
}

router.get('/live', async (req, res) => {
  try {
    res.json({ success: true, live: await buildLiveMetrics() });
  } catch (err) {
    console.error(`${LOG_PREFIX} live metrics error:`, err.message);
    res.status(500).json({ error: 'live_failed' });
  }
});

// ---- Settings: validate + persist -------------------------------------

function validateSettingsBody(body = {}) {
  const errors = [];
  const out = {};
  const numField = (name, min, max) => {
    if (body[name] === undefined) return;
    const v = Number(body[name]);
    if (!Number.isInteger(v) || v < min || v > max) errors.push(`${name} must be an integer ${min}..${max}`);
    else out[name] = v;
  };
  const boolField = (name) => { if (body[name] !== undefined) out[name] = !!body[name]; };

  if (body.defaultStrategy !== undefined) {
    if (!['static', 'adaptive', 'ml'].includes(body.defaultStrategy)) errors.push('defaultStrategy must be static/adaptive/ml');
    else out.defaultStrategy = body.defaultStrategy;
  }
  if (body.defaultDurationMinutes !== undefined) {
    const d = Number(body.defaultDurationMinutes);
    if (![30, 60, 120].includes(d)) errors.push('defaultDurationMinutes must be 30, 60 or 120');
    else out.defaultDurationMinutes = d;
  }
  numField('defaultMinViews', 0, 100000000);
  numField('defaultMaxViews', 0, 100000000);
  numField('rebalanceIntervalSec', 30, 3600);
  numField('maxItemSharePct', 1, 100);
  numField('cooldownCycles', 0, 100);
  numField('workerCount', 1, 64);
  numField('batchSize', 1, 1000);
  numField('pollIntervalMs', 100, 60000);
  numField('retryAttempts', 0, 20);
  ['autoRollback', 'allowRestart', 'allowDuplicateCampaign', 'enableGeoTargeting', 'enableLiveSync', 'globalDryRun'].forEach(boolField);

  return errors.length ? { errors } : { value: out };
}

router.put('/settings', async (req, res) => {
  const body = req.body || {};
  const { value, errors } = validateSettingsBody(body);
  if (errors) return res.status(400).json({ error: 'validation_failed', errors });
  try {
    // Engine ON/OFF is LIVE and lives in AppSettings (what the engine reads).
    let engineChange = null;
    if (typeof body.engineEnabled === 'boolean') {
      let app = await AppSettings.findOne({ key: 'update_flags' });
      if (!app) app = new AppSettings();
      engineChange = { before: !!app.viewEngineEnabled, after: body.engineEnabled };
      app.viewEngineEnabled = body.engineEnabled;
      await app.save();
      await config.refreshEnabled();
    }

    let settings = await ViewEngineSettings.findOne({ key: 'view_engine_settings' });
    if (!settings) settings = new ViewEngineSettings({ key: 'view_engine_settings' });
    const before = settings.toObject();
    Object.assign(settings, value);
    // cross-field check on the merged document
    if (settings.defaultMaxViews < settings.defaultMinViews) {
      return res.status(400).json({ error: 'validation_failed', errors: ['defaultMaxViews must be >= defaultMinViews'] });
    }
    await settings.save();

    await writeAudit(req, {
      action: 'view_engine_settings_update',
      entityType: 'ViewEngineSettings',
      entityId: settings._id,
      description: 'Updated View Engine settings' + (engineChange ? ` (engine ${engineChange.after ? 'ON' : 'OFF'})` : ''),
      before: { engineEnabled: engineChange ? engineChange.before : undefined, ...before },
      after: { engineEnabled: engineChange ? engineChange.after : undefined, ...settings.toObject() }
    });
    res.json({ success: true, engineEnabled: config.isEnabledCached(), settings });
  } catch (err) {
    console.error(`${LOG_PREFIX} settings update error:`, err.message);
    res.status(500).json({ error: 'settings_update_failed' });
  }
});

// ---- Emergency Stop: engine OFF + pause all active campaigns -----------

router.post('/emergency-stop', async (req, res) => {
  try {
    let app = await AppSettings.findOne({ key: 'update_flags' });
    if (!app) app = new AppSettings();
    const before = !!app.viewEngineEnabled;
    app.viewEngineEnabled = false;
    await app.save();
    await config.refreshEnabled();
    const paused = await ViewCampaign.updateMany({ status: 'active' }, { $set: { status: 'paused' } });
    const count = paused.modifiedCount || 0;
    await writeAudit(req, {
      action: 'view_engine_emergency_stop',
      entityType: 'AppSettings',
      entityId: app._id,
      description: `EMERGENCY STOP — engine OFF, ${count} campaign(s) paused`,
      before: { engineEnabled: before },
      after: { engineEnabled: false, campaignsPaused: count }
    });
    res.json({ success: true, campaignsPaused: count });
  } catch (err) {
    console.error(`${LOG_PREFIX} emergency stop error:`, err.message);
    res.status(500).json({ error: 'emergency_stop_failed' });
  }
});

// ---- Status page: full live monitoring payload ------------------------

function formatUptime(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (d) parts.push(d + 'd');
  if (h || d) parts.push(h + 'h');
  parts.push(m + 'm');
  parts.push(s + 's');
  return parts.join(' ');
}

router.get('/status-data', async (req, res) => {
  try {
    const base = await buildLiveMetrics();
    const now = Date.now();
    const [completed, cancelled, reversed, activeList, lastLog] = await Promise.all([
      ViewCampaign.countDocuments({ status: 'completed' }),
      ViewCampaign.countDocuments({ status: 'cancelled' }),
      ViewCampaign.countDocuments({ status: 'reversed' }),
      ViewCampaign.find({ status: 'active' }).select('name durationMinutes durationType startAt').sort({ startAt: -1 }).limit(20).lean(),
      ViewCycleLog.findOne({}).select('cycleIndex createdAt').sort({ createdAt: -1 }).lean()
    ]);

    const activeCampaignsList = activeList.map((c) => {
      const start = c.startAt ? new Date(c.startAt).getTime() : now;
      return {
        id: String(c._id),
        name: c.name || '(unnamed)',
        durationType: c.durationType || 'finite',
        durationMinutes: c.durationMinutes,
        cycle: Math.max(0, Math.floor((now - start) / 60000))
      };
    });

    let recentActivity = [];
    try {
      const logs = await AuditLog.find({ action: { $regex: 'view_engine' } })
        .sort({ createdAt: -1 }).limit(8).lean();
      recentActivity = logs.map((l) => ({
        time: new Date(l.createdAt).toLocaleString(),
        event: l.description || l.action,
        user: l.actorName || 'System'
      }));
    } catch (_) { /* ignore */ }

    res.json({
      success: true,
      status: {
        ...base, // engineEnabled, killed, redis, mongo, queue, leader, workers, queueSize, activeCampaigns(count), lastHeartbeat, version, lastRestart
        completedCampaigns: completed,
        failedCampaigns: cancelled + reversed,
        currentCycle: lastLog ? lastLog.cycleIndex : 0,
        lastCycleAt: lastLog ? new Date(lastLog.createdAt).toLocaleTimeString() : 'N/A',
        uptime: formatUptime(process.uptime()),
        activeCampaignsList,
        recentActivity
      }
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} status-data error:`, err.message);
    res.status(500).json({ error: 'status_data_failed' });
  }
});


// ---- Live Status (Production Monitoring) -------------------------------
router.get('/live-status', async (req, res) => {
  try {
    const ViewDistributionState = require('../models/ViewDistributionState');
    const ViewCampaign = require('../models/ViewCampaign');
    const ViewCycleLog = require('../models/ViewCycleLog');
    const AuditLog = require('../../../models/AuditLog');
    const queue = require('../queue');
    const { redisClient, isRedisAvailable } = require('../../../config/redis');

    const now = new Date();

    // 1. Active Campaigns
    const activeCampaigns = await ViewCampaign.find({ status: 'active' }).lean();
    const activeCampaignsData = activeCampaigns.map(c => {
      const start = c.startAt ? new Date(c.startAt).getTime() : now.getTime();
      const elapsedMins = (now.getTime() - start) / 60000;
      const progress = c.durationMinutes ? Math.min(100, (elapsedMins / c.durationMinutes) * 100) : 0;
      return {
        id: String(c._id),
        name: c.name || '(unnamed)',
        startTime: c.startAt,
        durationMinutes: c.durationMinutes,
        progress: progress.toFixed(1),
        targetRange: `${c.minViews} - ${c.maxViews}`,
        status: c.status,
        elapsedMins: elapsedMins.toFixed(1)
      };
    });

    // 2. Engine metrics
    let queueSize = 0;
    let leader = 'Unknown';
    if (isRedisAvailable()) {
      try {
        const qStats = await queue.stats();
        queueSize = qStats.available ? (qStats.stream || 0) : 0;
        leader = await redisClient.get('vde:leader') || 'Unknown';
      } catch(e) {}
    }

    const lastLog = await ViewCycleLog.findOne().sort({ createdAt: -1 }).lean();
    const currentCycle = lastLog ? lastLog.cycleIndex : 0;
    
    const fifteenMinsAgo = new Date(now.getTime() - 15 * 60000);
    const workers = await ViewCycleLog.distinct('workerId', { createdAt: { $gte: fifteenMinsAgo } });

    // Speed calculation (views per minute based on last 5 minutes)
    const fiveMinsAgo = new Date(now.getTime() - 5 * 60000);
    const recentLogs = await ViewCycleLog.find({ createdAt: { $gte: fiveMinsAgo } }).lean();
    const recentViewsAdded = recentLogs.reduce((sum, log) => sum + (log.totalIncrement || 0), 0);
    const processingSpeed = Math.round(recentViewsAdded / 5);

    // 3. Current Processing News
    let processingNews = [];
    if (activeCampaigns.length > 0) {
      // Find up to 10 actively tracking news items
      const activeStates = await ViewDistributionState.find({ campaignId: { $in: activeCampaigns.map(c => c._id) } })
        .populate('newsId', 'title views syntheticViews _id')
        .limit(10)
        .lean();

      processingNews = activeStates.map(st => {
        const n = st.newsId || {};
        const cap = st.cap || 1; // avoid /0
        const totalDelivered = st.deliveredTotal || 0;
        const progress = Math.min(100, (totalDelivered / cap) * 100).toFixed(1);
        
        return {
          newsId: n._id ? String(n._id) : 'unknown',
          title: n.title || 'Unknown Title',
          organicViews: n.views || 0,
          syntheticViews: totalDelivered,
          displayViews: (n.views || 0) + totalDelivered,
          targetViews: cap,
          remainingViews: Math.max(0, cap - totalDelivered),
          progress: progress,
          campaignId: String(st.campaignId)
        };
      });
    }

    // Estimated finish time overall (just an approximation based on speed)
    let estimatedFinishTime = 'N/A';
    if (processingNews.length > 0 && processingSpeed > 0) {
      const totalRemaining = processingNews.reduce((s, n) => s + n.remainingViews, 0);
      const minsRemaining = totalRemaining / processingSpeed;
      if (minsRemaining < 10000) {
        estimatedFinishTime = new Date(now.getTime() + minsRemaining * 60000).toLocaleString();
      }
    }

    // 4. Logs and Errors
    const engineLogs = await ViewCycleLog.find({}).sort({ createdAt: -1 }).limit(20).lean();
    const formattedLogs = engineLogs.map(l => ({
      time: new Date(l.createdAt).toLocaleTimeString(),
      event: `Cycle ${l.cycleIndex} processed`,
      type: 'info',
      details: `${l.itemsAffected} items boosted. +${l.totalIncrement} views.`,
      workerId: l.workerId
    }));

    const auditLogs = await AuditLog.find({ action: { $regex: 'view_engine' } }).sort({ createdAt: -1 }).limit(10).lean();
    const formattedAudit = auditLogs.map(l => ({
      time: new Date(l.createdAt).toLocaleTimeString(),
      event: l.description || l.action,
      type: l.action.includes('error') ? 'error' : 'success',
      details: l.actorName || 'System',
      workerId: 'System'
    }));

    const combinedLogs = [...formattedLogs, ...formattedAudit].sort((a,b) => new Date(b.time) - new Date(a.time)).slice(0, 50);

    res.json({
      success: true,
      data: {
        activeCampaigns: activeCampaignsData,
        processingNews: processingNews,
        engine: {
          queueSize,
          workers: workers.length,
          leader,
          processingSpeed,
          currentCycle,
          estimatedFinishTime,
          startedTime: activeCampaignsData.length ? new Date(activeCampaignsData[0].startTime).toLocaleTimeString() : 'N/A',
          lastUpdateTime: now.toLocaleTimeString()
        },
        logs: combinedLogs
      }
    });
  } catch (err) {
    console.error('Error in /live-status:', err);
    res.status(500).json({ error: 'failed_to_fetch_live_status' });
  }
});

module.exports = router;
