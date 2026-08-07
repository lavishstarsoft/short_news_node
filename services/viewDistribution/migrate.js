'use strict';

/**
 * migrate.js — provisioning for the Smart View Distribution Engine.
 *
 * OFF-first, idempotent, zero-downtime. Run manually AFTER deploying the code
 * (which ships with the flag OFF):
 *
 *   node services/viewDistribution/migrate.js
 *
 * What it does (all safe to re-run):
 *   1. Ensures AppSettings.viewEngineEnabled exists, defaulting OFF — WITHOUT
 *      overriding a value an admin already set.
 *   2. Verifies News.syntheticViews is present in the schema (no data backfill —
 *      missing field reads as 0 via the schema default, so there is nothing to
 *      rewrite on millions of docs → zero-downtime).
 *   3. Explicitly createIndexes() for the 3 engine collections. Because the engine
 *      schemas use autoIndex:false, this is the ONLY place their indexes/collections
 *      are created — nothing appears at server boot while the engine is OFF.
 *
 * It changes NO runtime behavior and touches no existing collections' indexes.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const AppSettings = require('../../models/AppSettings');
const News = require('../../models/News');
const ViewCampaign = require('./models/ViewCampaign');
const ViewDistributionState = require('./models/ViewDistributionState');
const ViewCycleLog = require('./models/ViewCycleLog');
const { LOG_PREFIX } = require('./constants');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/short_news';

/** Ensure the single ON/OFF flag exists (default OFF); never override an existing value. */
async function ensureFlag() {
  let settings = await AppSettings.findOne({ key: 'update_flags' });
  if (!settings) {
    settings = await new AppSettings().save(); // schema default viewEngineEnabled:false
    return { action: 'created_settings', enabled: !!settings.viewEngineEnabled };
  }
  if (settings.viewEngineEnabled === undefined || settings.viewEngineEnabled === null) {
    settings.viewEngineEnabled = false;
    await settings.save();
    return { action: 'initialized_flag_off', enabled: false };
  }
  return { action: 'already_present', enabled: !!settings.viewEngineEnabled };
}

/** Verify the synthetic field exists in the schema. No backfill (default 0 on read). */
async function verifySyntheticViews() {
  const hasPath = !!News.schema.path('syntheticViews');
  // estimatedDocumentCount uses collection metadata — fast, no collscan (zero-downtime).
  const totalNews = await News.estimatedDocumentCount();
  return {
    hasPath,
    totalNews,
    note: 'missing field reads as 0 (schema default); no backfill required'
  };
}

/** Explicitly build the engine indexes (idempotent — only missing ones are created). */
async function createEngineIndexes() {
  const models = [
    ['ViewCampaign', ViewCampaign],
    ['ViewDistributionState', ViewDistributionState],
    ['ViewCycleLog', ViewCycleLog]
  ];
  const out = {};
  for (const [name, Model] of models) {
    await Model.createIndexes();
    const idx = await Model.collection.indexes().catch(() => []);
    out[name] = idx.map((i) => i.name);
  }
  return out;
}

async function run() {
  console.log(`${LOG_PREFIX} migration starting…`);
  await mongoose.connect(MONGO_URI);
  try {
    const flag = await ensureFlag();
    console.log(`${LOG_PREFIX} flag:`, flag);

    const sv = await verifySyntheticViews();
    console.log(`${LOG_PREFIX} News.syntheticViews:`, sv);
    if (!sv.hasPath) {
      throw new Error('News.syntheticViews schema path missing — deploy the Phase-2 field first');
    }

    const indexes = await createEngineIndexes();
    console.log(`${LOG_PREFIX} engine indexes ensured:`, indexes);

    console.log(`${LOG_PREFIX} migration complete — engine remains ${flag.enabled ? 'ON' : 'OFF'}.`);
    return { flag, syntheticViews: sv, indexes };
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`${LOG_PREFIX} migration failed:`, err);
      process.exit(1);
    });
}

module.exports = { run, ensureFlag, verifySyntheticViews, createEngineIndexes };
