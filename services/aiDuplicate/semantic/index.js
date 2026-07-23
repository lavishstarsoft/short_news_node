'use strict';

/**
 * Semantic infrastructure facade — Phase-4.2 PENDING enqueue on create/update.
 * Does not change duplicate decisions / gateway response shape.
 */

const constants = require('./constants');
const flags = require('./flags');
const statuses = require('./statuses');
const newsVectorContract = require('./newsVectorContract');
const embedJobContract = require('./embedJobContract');
const lifecycle = require('./lifecycle');
const embedResponseValidator = require('./embedResponseValidator');
const newsVectorPersistence = require('./newsVectorPersistence');
const vectorSearchService = require('./vectorSearchService');
const semanticShadowMetricContract = require('./semanticShadowMetricContract');
const semanticShadowStore = require('./semanticShadowStore');
const semanticShadowService = require('./semanticShadowService');
const semanticAdvisoryService = require('./semanticAdvisoryService');
const embedWorkerMetrics = require('./embedWorkerMetrics');
const embedPendingWorker = require('./embedPendingWorker');
const scheduleNewsVectorPending = require('./scheduleNewsVectorPending');
const newsVectorQueueMetrics = require('./newsVectorQueueMetrics');
const embedPipelineHealth = require('./embedPipelineHealth');

module.exports = {
  constants,
  ...flags,
  ...statuses,
  ...newsVectorContract,
  ...embedJobContract,
  ...lifecycle,
  ...embedResponseValidator,
  createNewsVectorPersistence: newsVectorPersistence.createNewsVectorPersistence,
  ensurePending: newsVectorPersistence.ensurePending,
  persistEmbedSuccess: newsVectorPersistence.persistEmbedSuccess,
  persistEmbedFailure: newsVectorPersistence.persistEmbedFailure,
  markStale: newsVectorPersistence.markStale,
  markStaleAndPrepareReembed: newsVectorPersistence.markStaleAndPrepareReembed,
  createVectorSearchService: vectorSearchService.createVectorSearchService,
  buildVectorSearchPipeline: vectorSearchService.buildVectorSearchPipeline,
  searchSimilar: vectorSearchService.searchSimilar,
  validateQueryEmbedding: vectorSearchService.validateQueryEmbedding,
  buildShadowMetric: semanticShadowMetricContract.buildShadowMetric,
  assertMetricHasNoArticleText:
    semanticShadowMetricContract.assertMetricHasNoArticleText,
  createSemanticShadowStore: semanticShadowStore.createSemanticShadowStore,
  createSemanticShadowService: semanticShadowService.createSemanticShadowService,
  extractExactNearSnapshots: semanticShadowService.extractExactNearSnapshots,
  evaluateSemanticShadow: semanticShadowService.evaluate,
  scheduleSemanticShadow: semanticShadowService.schedule,
  createSemanticAdvisoryService:
    semanticAdvisoryService.createSemanticAdvisoryService,
  getSemanticAdvisory: semanticAdvisoryService.getSemanticAdvisory,
  loadAdvisoryThresholds: semanticAdvisoryService.loadAdvisoryThresholds,
  filterAndRankCandidates: semanticAdvisoryService.filterAndRankCandidates,
  createEmbedWorkerMetrics: embedWorkerMetrics.createEmbedWorkerMetrics,
  createEmbedPendingWorker: embedPendingWorker.createEmbedPendingWorker,
  loadEmbedWorkerConfig: embedPendingWorker.loadEmbedWorkerConfig,
  computeBackoffMs: embedPendingWorker.computeBackoffMs,
  maybeStartEmbedPendingWorker: embedPendingWorker.maybeStartEmbedPendingWorker,
  stopEmbedPendingWorker: embedPendingWorker.stopEmbedPendingWorker,
  createEmbedWorkerClaim: require('./embedWorkerClaim').createEmbedWorkerClaim,
  createNewsVectorPendingScheduler:
    scheduleNewsVectorPending.createNewsVectorPendingScheduler,
  schedulePendingAfterCreate:
    scheduleNewsVectorPending.schedulePendingAfterCreate,
  schedulePendingAfterUpdate:
    scheduleNewsVectorPending.schedulePendingAfterUpdate,
  createNewsVectorQueueMetrics:
    newsVectorQueueMetrics.createNewsVectorQueueMetrics,
  createEmbedPipelineHealth: embedPipelineHealth.createEmbedPipelineHealth,
  phase: '4.3',
  wiredToRequestPath: true,
  pendingEnqueueOnly: true,
  workerClaimLease: true,
  observability: true,
  semanticDecidesDuplicates: false,
  semanticAdvisoryOnly: true,
  executableWorkers: true,
  embedWorkerDefaultOff: true,
};
