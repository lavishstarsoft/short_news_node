#!/usr/bin/env node
'use strict';

/**
 * Phase-4.3 — print embedding pipeline health JSON (ops).
 *
 * Usage:
 *   node scripts/embed-pipeline-health.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (uri) {
    await mongoose.connect(uri);
  }

  const {
    createEmbedPipelineHealth,
  } = require('../services/aiDuplicate/semantic/embedPipelineHealth');

  const health = createEmbedPipelineHealth();
  const report = await health.getHealthReport();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));

  if (uri) {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
