'use strict';

/**
 * TEHELKA NEXA — task / decision audit record.
 *
 * Append-only history of everything NEXA does or *would* do (shadow mode). This
 * is the source for the Command Center and for measuring accuracy vs humans.
 * It NEVER stores or mutates business data — only references (e.g. newsId) and
 * the decision NEXA made.
 */

const mongoose = require('mongoose');

const nexaTaskSchema = new mongoose.Schema(
  {
    workflow: { type: String, required: true, index: true }, // e.g. 'submission_gate'
    action: { type: String, default: null }, // logical action name
    entityType: { type: String, default: null }, // e.g. 'news'
    entityId: { type: String, default: null, index: true },

    status: {
      type: String,
      enum: ['queued', 'running', 'completed', 'failed', 'skipped', 'awaiting_approval'],
      default: 'queued',
      index: true,
    },
    // 'shadow' = recorded only; 'live' = actually executed; 'blocked' = not allowed
    mode: { type: String, enum: ['shadow', 'live', 'blocked'], default: 'shadow' },

    autonomyLevel: { type: Number, default: 0 },
    confidence: { type: Number, default: null },

    // What NEXA decided / would have done, and (later) what a human actually did.
    aiDecision: { type: mongoose.Schema.Types.Mixed, default: null },
    humanDecision: { type: mongoose.Schema.Types.Mixed, default: null },
    matchedHuman: { type: Boolean, default: null }, // for accuracy measurement

    reason: { type: String, default: null },
    error: { type: String, default: null },
    tokensUsed: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    durationMs: { type: Number, default: null },

    requiresApproval: { type: Boolean, default: false },
    approvedByName: { type: String, default: null },
    approvedById: { type: String, default: null },
    approvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

nexaTaskSchema.index({ workflow: 1, status: 1, createdAt: -1 });
nexaTaskSchema.index({ requiresApproval: 1, status: 1, createdAt: 1 });

module.exports =
  mongoose.models.NexaTask || mongoose.model('NexaTask', nexaTaskSchema);
