// db-backup-cron.js — run a single MongoDB→R2 backup, then exit.
// Scheduled every 3 hours by system cron:
//   0 */3 * * * cd /var/www/yellowsingam && /usr/bin/node tools/db-backup-cron.js >> /var/log/db-backup.log 2>&1
try { require('dotenv').config(); } catch (_) {}

(async () => {
  const started = new Date().toISOString();
  try {
    const backup = require('../services/dbBackupService');
    const r = await backup.createBackup();
    console.log(`[${started}] backup OK → ${r.key} (${r.sizeBytes} bytes)`);
    process.exit(0);
  } catch (e) {
    console.error(`[${started}] backup FAILED: ${e && e.message ? e.message : e}`);
    process.exit(1);
  }
})();
