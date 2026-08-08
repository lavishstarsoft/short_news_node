// View Engine Controller - Isolated module for View Engine UI
const AppSettings = require('../models/AppSettings');

const renderDashboard = async (req, res) => {
    // Basic superadmin check (though routes should also protect this)
    if (!req.admin || req.admin.role !== 'superadmin') {
        return res.status(403).render('error', { message: 'Unauthorized. Super Admin access only.' });
    }

    // Fetch real engine status
    let settings = null;
    try {
        settings = await AppSettings.findOne({});
    } catch (err) {
        console.error('Error fetching AppSettings:', err);
    }
    const isEngineEnabled = settings && settings.viewEngineEnabled === true;

    const mongoose = require('mongoose');
    const ViewCampaign = require('../services/viewDistribution/models/ViewCampaign');
    const ViewCycleLog = require('../services/viewDistribution/models/ViewCycleLog');
    const queue = require('../services/viewDistribution/queue');
    const { redisClient, isRedisAvailable } = require('../config/redis');
    const AuditLog = require('../models/AuditLog'); // Assuming AuditLog exists

    // Calculate start of today for metrics
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // Fetch Today's Stats from Cycle Logs
    let totalViews = 0;
    let totalCycles = 0;
    try {
        const todayStats = await ViewCycleLog.aggregate([
            { $match: { createdAt: { $gte: startOfToday } } },
            { $group: { _id: null, totalViews: { $sum: "$totalIncrement" }, totalCycles: { $sum: 1 } } }
        ]);
        if (todayStats && todayStats.length) {
            totalViews = todayStats[0].totalViews;
            totalCycles = todayStats[0].totalCycles;
        }
    } catch (err) {
        console.error('Error fetching cycle stats:', err);
    }

    // Active Campaigns count
    let activeCampaigns = 0;
    try {
        activeCampaigns = await ViewCampaign.countDocuments({ status: 'active' });
    } catch (err) {}

    // Queue Stats
    const qStats = await queue.stats();
    const queueSize = qStats.available ? (qStats.stream || 0) : 0;

    // Leader and Heartbeat
    let leader = 'Unknown';
    let lastHeartbeat = 'N/A';
    if (isRedisAvailable()) {
        try {
            leader = await redisClient.get('vde:leader') || 'Unknown';
            const hb = await redisClient.get('vde:heartbeat');
            lastHeartbeat = hb ? new Date(parseInt(hb)).toLocaleTimeString() : 'N/A';
        } catch (err) {}
    }

    // Active Workers (distinct in last 15 mins)
    let activeWorkers = 0;
    try {
        const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
        const workersList = await ViewCycleLog.distinct('workerId', { createdAt: { $gte: fifteenMinsAgo } });
        activeWorkers = workersList.length;
    } catch (err) {}

    // Recent Logs from AuditLog
    let recentLogs = [];
    try {
        const logs = await AuditLog.find({ action: { $regex: 'view_engine' } })
            .sort({ createdAt: -1 })
            .limit(5)
            .lean();
        
        recentLogs = logs.map(log => ({
            id: log._id.toString().substring(18),
            time: new Date(log.createdAt).toLocaleTimeString(),
            event: log.description || log.action,
            user: log.actorName || 'System'
        }));
    } catch (err) {}

    if (recentLogs.length === 0) {
        recentLogs = [{ id: '-', time: '-', event: 'No recent activity', user: '-' }];
    }

    // Format Large Numbers
    const formatViews = (v) => {
        if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
        if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
        return v || 0;
    };

    // Health
    const redisHealth = isRedisAvailable() ? 'Healthy' : 'Down';
    const mongoHealth = mongoose.connection.readyState === 1 ? 'Healthy' : 'Down';
    const queueHealth = qStats.available ? 'Healthy' : 'Degraded';

    const liveData = {
        engineStatus: isEngineEnabled ? 'Running' : 'Stopped',
        killSwitchEnabled: isEngineEnabled,
        activeCampaigns: activeCampaigns,
        queueSize: queueSize,
        leader: leader,
        workers: activeWorkers,
        todaySyntheticViews: formatViews(totalViews),
        processedCycles: totalCycles,
        lastHeartbeat: lastHeartbeat,
        redisHealth: redisHealth,
        mongoHealth: mongoHealth,
        queueHealth: queueHealth,
        dryRun: false,
        recentLogs: recentLogs,
        recentErrors: [] // Implement errors tracking if needed
    };

    res.render('view-engine/dashboard', {
        admin: req.admin,
        activePage: 'view-engine-dashboard',
        data: liveData
    });
};

const renderCampaigns = async (req, res) => {
    if (!req.admin || req.admin.role !== 'superadmin') return res.status(403).send('Unauthorized');
    
    let campaigns = [];
    try {
        const ViewCampaign = require('../services/viewDistribution/models/ViewCampaign');
        const rawCampaigns = await ViewCampaign.find({}).sort({ createdAt: -1 }).lean();
        const now = new Date().getTime();
        
        campaigns = rawCampaigns.map(c => {
            let progress = 0;
            if (c.status === 'active' && c.startAt && c.durationMinutes) {
                const start = new Date(c.startAt).getTime();
                const elapsedMins = (now - start) / 60000;
                progress = Math.min(100, (elapsedMins / c.durationMinutes) * 100).toFixed(1);
            } else if (c.status === 'completed') {
                progress = 100;
            }
            return { ...c, progress };
        });
    } catch (err) {
        console.error('Error fetching campaigns:', err);
    }
    
    res.render('view-engine/campaigns', {
        admin: req.admin,
        activePage: 'view-engine-campaigns',
        data: { campaigns }
    });
};

const renderStatus = (req, res) => {
    if (!req.admin || req.admin.role !== 'superadmin') return res.status(403).send('Unauthorized');
    res.render('view-engine/status', {
        admin: req.admin,
        activePage: 'view-engine-status'
    });
};

const renderSettings = async (req, res) => {
    if (!req.admin || req.admin.role !== 'superadmin') return res.status(403).send('Unauthorized');

    const mongoose = require('mongoose');
    const AppSettings = require('../models/AppSettings');
    const ViewEngineSettings = require('../services/viewDistribution/models/ViewEngineSettings');
    const ViewCampaign = require('../services/viewDistribution/models/ViewCampaign');
    const ViewCycleLog = require('../services/viewDistribution/models/ViewCycleLog');
    const queue = require('../services/viewDistribution/queue');
    const { redisClient, isRedisAvailable } = require('../config/redis');

    // Engine ON/OFF (live source of truth) + persisted settings (defaults if absent).
    let engineEnabled = false;
    try {
        const app = await AppSettings.findOne({ key: 'update_flags' });
        engineEnabled = !!(app && app.viewEngineEnabled === true);
    } catch (err) { console.error('Error fetching AppSettings:', err); }

    let settings = null;
    try {
        settings = await ViewEngineSettings.findOne({ key: 'view_engine_settings' }).lean();
    } catch (err) { console.error('Error fetching ViewEngineSettings:', err); }
    if (!settings) {
        // Not saved yet — use schema defaults (real defaults, not mock).
        settings = new ViewEngineSettings({ key: 'view_engine_settings' }).toObject();
    }

    // Live metrics (read-only, real sources).
    const redisUp = isRedisAvailable();
    const mongoUp = mongoose.connection.readyState === 1;
    let leader = 'None';
    let lastHeartbeat = 'N/A';
    if (redisUp) {
        try { leader = (await redisClient.get('vde:leader')) || 'None'; } catch (err) {}
        try {
            const hb = await redisClient.get('vde:heartbeat');
            if (hb) lastHeartbeat = new Date(parseInt(hb, 10)).toLocaleTimeString();
        } catch (err) {}
    }
    const qStats = await queue.stats();
    let activeCampaigns = 0;
    try { activeCampaigns = await ViewCampaign.countDocuments({ status: 'active' }); } catch (err) {}
    let workers = 0;
    try {
        const since = new Date(Date.now() - 15 * 60 * 1000);
        workers = (await ViewCycleLog.distinct('workerId', { createdAt: { $gte: since } })).length;
    } catch (err) {}

    const live = {
        engineEnabled,
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

    res.render('view-engine/settings', {
        admin: req.admin,
        activePage: 'view-engine-settings',
        engineEnabled,
        settings,
        live
    });
};

module.exports = {
    renderDashboard,
    renderCampaigns,
    renderStatus,
    renderSettings
};
