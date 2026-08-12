'use strict';

/**
 * securityAlertController — Security Center (Threat Monitor) dashboard for the
 * Security Alert Engine. SEPARATE from the existing referral "Security & Fraud"
 * page (controllers/securityController.js) — that one is left untouched.
 *
 * Read-only + two permitted actions: resolve an alert, manual IP unblock.
 * Admin/superadmin only. Reuses the existing EJS layout + SecurityAlert model.
 */

const SecurityAlert = require('../models/SecurityAlert');
const engine = require('../services/security/alertEngine');

function isAdmin(req) {
  return req.admin && (req.admin.role === 'admin' || req.admin.role === 'superadmin');
}

async function buildData() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [recent, sevCounts, topIps, topEndpoints, unresolved] = await Promise.all([
    SecurityAlert.find({}).sort({ createdAt: -1 }).limit(100).lean(),
    SecurityAlert.aggregate([{ $match: { resolved: false } }, { $group: { _id: '$severity', c: { $sum: 1 } } }]),
    SecurityAlert.aggregate([
      { $match: { createdAt: { $gte: since }, ip: { $ne: '' } } },
      { $group: { _id: '$ip', c: { $sum: '$count' }, sev: { $max: '$severity' } } },
      { $sort: { c: -1 } }, { $limit: 10 }
    ]),
    SecurityAlert.aggregate([
      { $match: { createdAt: { $gte: since }, endpoint: { $ne: '' } } },
      { $group: { _id: '$endpoint', c: { $sum: '$count' } } },
      { $sort: { c: -1 } }, { $limit: 10 }
    ]),
    SecurityAlert.countDocuments({ resolved: false })
  ]);
  const severity = { INFO: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  sevCounts.forEach((s) => { if (s._id in severity) severity[s._id] = s.c; });
  return { recent, severity, topIps, topEndpoints, unresolved, enforce: engine.CFG.enforce, generatedAt: new Date() };
}

exports.renderSecurityCenter = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).send('Access denied. Admins only.');
  try {
    const data = await buildData();
    res.render('security-center', { admin: req.admin, activePage: 'security-center', data });
  } catch (e) {
    console.error('Security center error:', e.message);
    res.status(500).send('Error loading Security Center');
  }
};

exports.securityData = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only' });
  try { res.json(await buildData()); } catch (e) { res.status(500).json({ error: 'Failed to load' }); }
};

// Only permitted mutation on an alert: mark resolved (append-only otherwise).
exports.resolveAlert = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only' });
  try {
    await SecurityAlert.updateOne(
      { _id: req.params.id },
      { $set: { resolved: true, resolvedAt: new Date(), resolvedBy: req.admin.username || req.admin.name || 'admin' } }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
};

// Manual rollback of an auto/temp IP block.
exports.unblockIp = async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admins only' });
  const ip = (req.body.ip || '').toString().trim();
  if (!ip) return res.status(400).json({ error: 'ip required' });
  try { await engine.unblockIp(ip); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: 'Failed' }); }
};
