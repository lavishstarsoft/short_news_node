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

    // Mock data for UI only (except killSwitchEnabled)
    const mockData = {
        engineStatus: isEngineEnabled ? 'Running' : 'Stopped',
        killSwitchEnabled: isEngineEnabled,
        activeCampaigns: 4,
        queueSize: 12050,
        leader: 'Node-1 (Primary)',
        workers: 12,
        todaySyntheticViews: '1.2M',
        processedCycles: 4892,
        lastHeartbeat: new Date().toISOString(),
        redisHealth: 'Healthy',
        mongoHealth: 'Healthy',
        queueHealth: 'Degraded',
        dryRun: false,
        recentLogs: [
            { id: 'L-101', time: '10:45:12 AM', event: 'Campaign #45 started', user: 'System' },
            { id: 'L-102', time: '10:40:00 AM', event: 'Scale up workers to 12', user: 'Auto-Scaler' },
            { id: 'L-103', time: '10:35:10 AM', event: 'Dry run disabled', user: 'admin123' },
        ],
        recentErrors: [
            { id: 'E-404', time: '10:22:15 AM', message: 'Worker Node-3 timeout' },
            { id: 'E-405', time: '10:15:00 AM', message: 'Queue backpressure detected' },
        ]
    };

    res.render('view-engine/dashboard', {
        admin: req.admin,
        activePage: 'view-engine-dashboard',
        data: mockData
    });
};

const renderCampaigns = (req, res) => {
    if (!req.admin || req.admin.role !== 'superadmin') return res.status(403).send('Unauthorized');
    res.render('view-engine/campaigns', {
        admin: req.admin,
        activePage: 'view-engine-campaigns'
    });
};

const renderStatus = (req, res) => {
    if (!req.admin || req.admin.role !== 'superadmin') return res.status(403).send('Unauthorized');
    res.render('view-engine/status', {
        admin: req.admin,
        activePage: 'view-engine-status'
    });
};

const renderSettings = (req, res) => {
    if (!req.admin || req.admin.role !== 'superadmin') return res.status(403).send('Unauthorized');
    res.render('view-engine/settings', {
        admin: req.admin,
        activePage: 'view-engine-settings'
    });
};

module.exports = {
    renderDashboard,
    renderCampaigns,
    renderStatus,
    renderSettings
};
