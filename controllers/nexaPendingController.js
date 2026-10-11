'use strict';

/**
 * TEHELKA NEXA — pending-news list endpoint (READ-ONLY).
 *
 * GET /admin/api/nexa/pending-news?skip=&limit=
 * Returns one page of the complete current pending queue (old→new) + total,
 * with NEXA's shadow triage recommendation joined where it already exists.
 * Never writes anything, never triggers triage. Superadmin-only (route-gated).
 */

const { fetchPendingPage } = require('../nexa/pendingNewsList');

async function listPending(req, res) {
  try {
    const skip = parseInt(req.query.skip, 10) || 0;
    const limit = parseInt(req.query.limit, 10) || 50;
    const page = await fetchPendingPage({ skip, limit });
    return res.json({ success: true, ...page });
  } catch (e) {
    console.error('[NEXA][pending] listPending failed:', e && e.message);
    return res.status(500).json({ success: false, error: 'server_error', te: 'లోపం జరిగింది. మళ్ళీ ప్రయత్నించండి.' });
  }
}

module.exports = { listPending };
