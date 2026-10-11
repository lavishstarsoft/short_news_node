'use strict';

/**
 * Device-token registration for our own FCM push (Phase 1 of "real delivered
 * count"). The app POSTs its FCM token here on launch / language change /
 * sign-in / token refresh. Upsert by token so repeat calls are cheap and never
 * create duplicates.
 *
 * Public + additive: no auth required (a token is not a secret, and old builds
 * simply never call it). If a verified Google id is present on the request we
 * record it so named-people (reporter / user) sends can target that phone.
 */
const express = require('express');
const router = express.Router();
const DeviceToken = require('../models/DeviceToken');

router.post('/api/public/fcm/register', async (req, res) => {
  try {
    const body = req.body || {};
    const token = String(body.token || '').trim();
    // An FCM token is long; reject obvious junk without being strict about format.
    if (token.length < 20 || token.length > 4096) {
      return res.status(400).json({ ok: false, error: 'invalid_token' });
    }
    const language = String(body.language || '').trim().toLowerCase().slice(0, 10);
    const platform = String(body.platform || 'android').trim().slice(0, 20);
    const appVersion = String(body.appVersion || '').trim().slice(0, 40);
    // Prefer a server-verified identity; fall back to a client-supplied id.
    const userId = String(req.verifiedGoogleId || body.userId || '').trim().slice(0, 80);

    await DeviceToken.updateOne(
      { token },
      {
        $set: { language, platform, appVersion, userId, lastSeenAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );
    return res.json({ ok: true });
  } catch (e) {
    // Never surface internals; registration failure must not break the app.
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
