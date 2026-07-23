#!/usr/bin/env node
'use strict';

/**
 * Standalone Phase-4.1 embed worker (optional).
 * Prefer AI_EMBED_WORKER_ENABLED=true on the main Node process.
 *
 * Usage:
 *   AI_EMBED_WORKER_ENABLED=true node scripts/run-embed-pending-worker.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI required');
    process.exit(1);
  }

  process.env.AI_EMBED_WORKER_ENABLED =
    process.env.AI_EMBED_WORKER_ENABLED || 'true';

  await mongoose.connect(uri);
  const {
    maybeStartEmbedPendingWorker,
    createEmbedPendingWorker,
  } = require('../services/aiDuplicate/semantic/embedPendingWorker');

  const started = maybeStartEmbedPendingWorker();
  console.log('[embed-worker]', started);

  // Also run one immediate batch
  const worker = createEmbedPendingWorker();
  const batch = await worker.processBatch({ force: true });
  console.log('[embed-worker] initial batch', {
    processed: batch.processed,
    metrics: batch.metrics,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
