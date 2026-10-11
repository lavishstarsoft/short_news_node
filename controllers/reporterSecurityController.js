'use strict';

/**
 * Reporter Security page (Super Admin): the security switches, red "one person — many
 * accounts" groups (shared UPI / bank / mobile), withdrawals on hold, and the reporter
 * app login history.
 */
const WithdrawalRequest = require('../models/WithdrawalRequest');
const ReporterLoginEvent = require('../models/ReporterLoginEvent');
const secSettings = require('../services/security/reporterSecuritySettings');
const { linkedGroups, deviceGroups, locationGroups } = require('../services/security/accountLinks');
const { logAudit } = require('../utils/auditLogger');

const IST_MS = 5.5 * 3600e3;
const istMidnight = (now = Date.now()) => {
  const d = new Date(now + IST_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_MS);
};

exports.renderPage = (req, res) => {
  res.render('reporter-security', { title: 'Reporter Security', admin: req.admin, activePage: 'reporter-security' });
};

exports.getOverview = async (req, res) => {
  try {
    const since = istMidnight();
    const [settings, groups, devices, places, held, recentLogins, loginsToday, failedToday] = await Promise.all([
      secSettings.get(),
      linkedGroups(),
      deviceGroups().catch((e) => { console.error('device groups failed:', e.message); return []; }),
      locationGroups().catch((e) => { console.error('location groups failed:', e.message); return []; }),
      WithdrawalRequest.find({ status: 'pending', 'fraudHold.held': true, 'fraudHold.clearedAt': null })
        .populate('adminId', 'name username mobileNumber reporterTier')
        .sort({ createdAt: -1 }).limit(200).lean(),
      ReporterLoginEvent.find({}).sort({ at: -1 }).limit(60)
        .populate('adminId', 'name username').lean(),
      ReporterLoginEvent.countDocuments({ at: { $gte: since }, success: true }),
      ReporterLoginEvent.countDocuments({ at: { $gte: since }, success: false }),
    ]);
    res.json({
      settings,
      groups,
      devices,
      places,
      held: held.map((w) => ({
        id: String(w._id),
        amount: w.amount,
        paymentDetails: w.paymentDetails,
        createdAt: w.createdAt,
        reporter: w.adminId ? {
          id: String(w.adminId._id), name: w.adminId.name || w.adminId.username, username: w.adminId.username,
          mobileNumber: w.adminId.mobileNumber || '', tier: w.adminId.reporterTier || null,
        } : null,
        reasons: ((w.fraudHold && w.fraudHold.reasons) || []).map((r) => r.label),
        linkedCount: ((w.fraudHold && w.fraudHold.linkedAdminIds) || []).length,
      })),
      logins: recentLogins.map((l) => ({
        at: l.at,
        name: l.adminId ? (l.adminId.name || l.adminId.username) : '',
        username: l.username,
        success: l.success,
        reason: l.reason,
        place: [l.city, l.region].filter(Boolean).join(', '),
        ip: l.ip,
        deviceModel: l.deviceModel || '',
        appVersion: l.appVersion || '',
      })),
      counts: {
        groups: groups.length,
        payoutGroups: groups.filter((g) => g.strength === 'payout').length,
        accountsInGroups: groups.reduce((s, g) => s + g.size, 0),
        devices: devices.length,
        sequentialDevices: devices.filter((d) => d.sequential).length,
        places: places.length,
        held: held.length,
        loginsToday,
        failedToday,
      },
    });
  } catch (e) {
    console.error('reporter security overview failed:', e);
    res.status(500).json({ error: 'Could not load reporter security data.' });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const before = await secSettings.get();
    const after = await secSettings.update(req.body || {}, req.admin && (req.admin.username || req.admin.id));
    const changed = Object.keys(after).filter((k) => before[k] !== after[k]);
    if (changed.length) {
      logAudit({
        req,
        action: 'reporter_security_settings',
        entityType: 'ReporterSecuritySettings',
        entityId: 'reporter_security',
        description: 'Reporter security switches changed: ' + changed.map((k) => `${k}=${after[k]}`).join(', '),
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, after[k]])),
      });
    }
    res.json({ ok: true, settings: after });
  } catch (e) {
    console.error('reporter security settings update failed:', e);
    res.status(500).json({ error: 'Could not save settings.' });
  }
};

/** Super Admin reviewed a held withdrawal and allows it to be paid (it stays pending). */
exports.clearHold = async (req, res) => {
  try {
    const note = String((req.body && req.body.note) || '').trim();
    if (note.length < 5) return res.status(400).json({ error: 'Write why this is fine (at least 5 characters).' });
    const w = await WithdrawalRequest.findById(req.params.id).populate('adminId', 'name username');
    if (!w) return res.status(404).json({ error: 'Withdrawal not found.' });
    if (!w.fraudHold || !w.fraudHold.held || w.fraudHold.clearedAt) return res.status(409).json({ error: 'This request is not on hold.' });
    w.fraudHold.clearedAt = new Date();
    w.fraudHold.clearedBy = (req.admin && (req.admin.id || req.admin._id)) || null;
    w.fraudHold.clearedByName = (req.admin && (req.admin.username || req.admin.name)) || '';
    w.fraudHold.clearNote = note.slice(0, 500);
    await w.save();
    logAudit({
      req,
      action: 'withdrawal_hold_cleared',
      entityType: 'WithdrawalRequest',
      entityId: w._id,
      targetId: w.adminId && w.adminId._id,
      targetName: w.adminId ? (w.adminId.name || w.adminId.username) : '',
      description: `Cleared fraud hold on ₹${w.amount} withdrawal — ${note}`,
      before: { held: true },
      after: { held: true, clearedAt: w.fraudHold.clearedAt },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('clear hold failed:', e);
    res.status(500).json({ error: 'Could not clear the hold.' });
  }
};
