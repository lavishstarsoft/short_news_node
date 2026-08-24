const Admin = require('../models/Admin');

async function processStringerMigration() {
  try {
    // Target Date: 25 August 2026 00:00:00 IST
    // UTC equivalent: 24 August 2026 18:30:00 UTC
    const targetDate = new Date('2026-08-24T18:30:00.000Z');
    
    if (new Date() < targetDate) {
      return; // Not yet time
    }

    // Update all reporters to stringer. Sub-editors are ignored because we filter by role: 'editor'
    const result = await Admin.updateMany(
      { 
        role: 'editor', 
        reporterTier: { $ne: 'stringer' } 
      },
      { 
        $set: { reporterTier: 'stringer' } 
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`✅ [StringerMigration] Automatically upgraded ${result.modifiedCount} reporters to stringer.`);
    }
  } catch (error) {
    console.error('❌ [StringerMigration] Error:', error);
  }
}

function startStringerMigrationCron() {
  // Run immediately once on server start
  processStringerMigration();

  // Then run every hour
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  setInterval(processStringerMigration, INTERVAL_MS);

  console.log('🕐 [StringerMigration] Started — scheduled to run migration on or after 25 Aug 2026');
}

module.exports = { startStringerMigrationCron, processStringerMigration };
