'use strict';
// Read-only OneSignal diagnostic. Loads env via dotenv (no secrets printed),
// checks client init, app subscriber counts, and recent notification delivery.
require('dotenv').config();

(async () => {
  console.log('ENV APP_ID set:', !!process.env.ONESIGNAL_APP_ID);
  console.log('ENV API_KEY set:', !!process.env.ONESIGNAL_API_KEY);

  const svc = require('../services/oneSignalService');
  console.log('client initialized:', !!svc.client);

  try {
    const app = await svc.getAppDetails();
    console.log('--- APP ---');
    console.log('name:', app.name);
    console.log('players (total devices):', app.players);
    console.log('messageable_players:', app.messageable_players);
  } catch (e) {
    console.log('getAppDetails ERROR:', e.statusCode || '', e.message || e);
    if (e.body) console.log('body:', JSON.stringify(e.body).slice(0, 300));
  }

  try {
    const notifs = await svc.getNotifications(6, 0);
    console.log('--- RECENT NOTIFICATIONS ---');
    (notifs.notifications || []).forEach(n => {
      const h = (n.headings && (n.headings.en || Object.values(n.headings)[0])) || '';
      console.log([
        new Date((n.queued_at || n.send_after || 0) * 1000).toISOString().slice(0, 16),
        'recipients=' + (n.successful != null ? n.successful : (n.recipients != null ? n.recipients : '?')),
        'failed=' + (n.failed != null ? n.failed : '?'),
        'errored=' + (n.errored != null ? n.errored : '?'),
        'title=' + String(h).slice(0, 40)
      ].join('  '));
    });
  } catch (e) {
    console.log('getNotifications ERROR:', e.statusCode || '', e.message || e);
    if (e.body) console.log('body:', JSON.stringify(e.body).slice(0, 300));
  }

  process.exit(0);
})();
