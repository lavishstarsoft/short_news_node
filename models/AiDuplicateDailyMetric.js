'use strict';

const mongoose = require('mongoose');

const aiDuplicateDailyMetricSchema = new mongoose.Schema(
  {
    dateKey: { type: String, required: true, unique: true, index: true },
    liveNewsCount: { type: Number, default: 0 },
    readyVectorCount: { type: Number, default: 0 },
    coveragePercent: { type: Number, default: 0 },
    openGroupCount: { type: Number, default: 0 },
    similarArticleCount: { type: Number, default: 0 },
    averageSimilarityPercent: { type: Number, default: 0 },
    highestSimilarityPercent: { type: Number, default: 0 },
    groupsCreatedThatDay: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    collection: 'ai_duplicate_daily_metrics',
  }
);

module.exports =
  mongoose.models.AiDuplicateDailyMetric ||
  mongoose.model('AiDuplicateDailyMetric', aiDuplicateDailyMetricSchema);
