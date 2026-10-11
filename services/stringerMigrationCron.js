const Admin = require('../models/Admin');

async function processStringerMigration() {
  try {
    // Target Date: 25 August 2026 00:00:00 IST
    // UTC equivalent: 24 August 2026 18:30:00 UTC
    const targetDate = new Date('2026-08-24T18:30:00.000Z');
    
    if (new Date() < targetDate) {
      return; // Not yet time
    }

    // Give reporters WITHOUT a tier a baseline 'stringer' tier. Sub-editors are
    // ignored (role: 'editor' filter). CRITICAL: never touch district_incharge —
    // $nin keeps both stringer and district_incharge untouched, so promoted
    // in-charges are not silently demoted back to stringer on the hourly run.
    const result = await Admin.updateMany(
      {
        role: 'editor',
        reporterTier: { $nin: ['stringer', 'district_incharge'] }
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
  // DISABLED: this was a ONE-TIME migration to give tier-less reporters a baseline
  // 'stringer' tier. Every reporter now has a tier, so there is nothing left to do.
  // It no longer runs on startup and no hourly interval is scheduled.
  // (processStringerMigration is kept exported for manual one-off use if ever needed.)
  console.log('🛑 [StringerMigration] Disabled — one-time migration already complete.');
}

module.exports = { startStringerMigrationCron, processStringerMigration };
