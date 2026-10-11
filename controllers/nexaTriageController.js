'use strict';

/**
 * TEHELKA NEXA — manual/test trigger for the Pending News Triage shadow workflow.
 * Superadmin-only (guarded by the route). Read-only w.r.t. production news: it
 * only creates shadow NexaTask recommendations. Inert when NEXA is disabled.
 */

async function runTriage(req, res) {
  try {
    const nexa = require('../nexa');
    // Ensure read-only tools are registered (idempotent; inert when disabled).
    try { nexa.init(); } catch (_) { /* non-fatal */ }

    const rawLimit = (req.body && req.body.limit) || (req.query && req.query.limit);
    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 10, 1), 50);

    const { run } = require('../nexa/workflows/pendingNewsTriage');
    const out = await run(
      { limit },
      { actorId: req.admin && req.admin.id, actorName: req.admin && (req.admin.username || req.admin.name) },
    );

    return res.json({ success: true, ...out });
  } catch (err) {
    // NEXA errors must never surface as a production failure.
    console.error('[NEXA][triage] trigger failed (non-fatal):', err && err.message);
    return res.status(500).json({ success: false, error: 'triage_failed' });
  }
}

/**
 * Process ONE bounded batch of NOT-YET-ANALYSED pending news. Call repeatedly to
 * drain the whole backlog safely (each call is bounded + idempotent). Superadmin.
 */
async function processPending(req, res) {
  try {
    const nexa = require('../nexa');
    try { nexa.init(); } catch (_) { /* non-fatal */ }

    const raw = (req.body && req.body.batchSize) || (req.query && req.query.batchSize);
    const batchSize = Math.min(Math.max(parseInt(raw, 10) || 15, 1), 50);
    const scanRaw = (req.body && req.body.scanCap) || (req.query && req.query.scanCap);
    const scanCap = Math.min(Math.max(parseInt(scanRaw, 10) || 500, batchSize), 2000);

    const { processOnce } = require('../nexa/workflows/triageProcessor');
    const out = await processOnce(
      { batchSize, scanCap },
      { actorId: req.admin && req.admin.id, actorName: req.admin && (req.admin.username || req.admin.name) },
    );
    return res.json({ success: true, ...out });
  } catch (err) {
    console.error('[NEXA][triage] processPending failed (non-fatal):', err && err.message);
    return res.status(500).json({ success: false, error: 'process_failed' });
  }
}

module.exports = { runTriage, processPending };
