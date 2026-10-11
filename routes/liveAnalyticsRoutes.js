'use strict';

// Live Analytics — real-time "who is online and on which screen right now"
// dashboard. Reads the in-memory livePresence snapshot (no DB load for the
// numbers; only a tiny title lookup for hot news). Fully additive & isolated.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../controllers/adminController');
const livePresence = require('../services/livePresence');

let News;
try { News = require('../models/News'); } catch (_) { News = null; }

// Dashboard page.
router.get('/', requireAuth, (req, res) => {
  res.render('live-analytics', { admin: req.admin });
});

// Snapshot the dashboard polls every few seconds.
router.get('/snapshot', requireAuth, async (req, res) => {
  const snap = livePresence.snapshot();
  // Enrich hot-news ids with their titles (small, bounded lookup).
  if (News && snap.hotNews && snap.hotNews.length) {
    try {
      const ids = snap.hotNews.map((h) => h.k);
      const rows = await News.find({ _id: { $in: ids } }).select('title').lean();
      const titleById = {};
      rows.forEach((r) => { titleById[String(r._id)] = r.title; });
      snap.hotNews = snap.hotNews.map((h) => ({
        ...h,
        title: titleById[h.k] || ('…' + String(h.k).slice(-6)),
      }));
    } catch (_) { /* ids only if lookup fails */ }
  }
  res.set('Cache-Control', 'no-store');
  res.json(snap);
});

// Rich data feed for the advanced dashboard — compact per-user rows + a
// newsId→title map for the hot-news view. All exploration happens client-side.
router.get('/data', requireAuth, async (req, res) => {
  const data = livePresence.detail();
  const titles = {};
  if (News && data.newsIds && data.newsIds.length) {
    try {
      const rows = await News.find({ _id: { $in: data.newsIds } }).select('title').lean();
      rows.forEach((r) => { titles[String(r._id)] = r.title; });
    } catch (_) { /* ids only */ }
  }
  data.titles = titles;
  res.set('Cache-Control', 'no-store');
  res.json(data);
});

module.exports = router;
