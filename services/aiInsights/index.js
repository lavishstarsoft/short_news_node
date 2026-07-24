'use strict';

const C = require('./constants');
const flags = require('./flags');
const { createScanService } = require('./scanService');
const { createDashboardService } = require('./dashboardService');
const {
  createInsightsScanWorker,
  maybeStartInsightsScanWorker,
  stopInsightsScanWorker,
} = require('./scanWorker');
const { buildWindowedEdges, clusterFromEdges, buildGroupDraft } = require('./groupBuilder');
const { cosineSimilarity, scoreToPercent } = require('./cosine');
const { createUnionFind } = require('./unionFind');
const groupStatusLogic = require('./groupStatusLogic');

module.exports = {
  constants: C,
  ...flags,
  createScanService,
  createDashboardService,
  createInsightsScanWorker,
  maybeStartInsightsScanWorker,
  stopInsightsScanWorker,
  buildWindowedEdges,
  clusterFromEdges,
  buildGroupDraft,
  cosineSimilarity,
  scoreToPercent,
  createUnionFind,
  ...groupStatusLogic,
};
