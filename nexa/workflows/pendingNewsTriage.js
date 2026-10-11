'use strict';

/**
 * TEHELKA NEXA — Workflow: "Pending News Triage" (SHADOW MODE, observe-only).
 *
 * For each eligible pending news item, NEXA reads signals through the existing
 * read-only tools and records an internal RECOMMENDATION as a shadow NexaTask.
 * It NEVER performs the recommended action — no publish/reject/delete/approve,
 * no wallet/tier, no reporter change. The only write is the NexaTask audit
 * record (mode: 'shadow', actionTaken: 'none'). Inert when NEXA is disabled.
 *
 * Signals (all via the whitelisted read-only tools):
 *   - getPendingTasks       → the batch of pending items (+ authorId)
 *   - checkDuplicate        → existing duplicate/semantic pipeline (reused)
 *   - getReporterReliability→ existing reliability data (reused)
 * Priority is a lightweight deterministic heuristic over available fields only
 * (no new AI provider, no LLM DB access).
 */

const WORKFLOW = 'pending_news_triage';
const VERSION = 1; // bump to force re-analysis of already-seen items

// Recommendation tokens (stored in NexaTask.action; displayed with spaces).
const REC = Object.freeze({
  REVIEW: 'REVIEW',
  PRIORITY_REVIEW: 'PRIORITY_REVIEW',
  POSSIBLE_DUPLICATE: 'POSSIBLE_DUPLICATE',
  LOW_PRIORITY: 'LOW_PRIORITY',
  NEEDS_HUMAN_VERIFICATION: 'NEEDS_HUMAN_VERIFICATION',
});

// Urgent cues (Telugu + English), kept small and explainable.
const URGENT_RE = /(breaking|urgent|అత్యవసర|మృతి|మరణం|ప్రమాద|accident|హత్య|murder|అగ్ని|fire|వరద|flood|అరెస్ట|arrest|blast|పేలుడు|rescue|అల్లర|riot|emergency)/i;

/** 'urgent' | 'normal' | 'low' — from available fields only. */
function estimatePriority(item, now = Date.now()) {
  const title = String(item.title || '');
  if (URGENT_RE.test(title)) return 'urgent';
  const ts = item.publishedAt ? new Date(item.publishedAt).getTime() : now;
  const ageH = (now - ts) / 3600000;
  if (ageH > 48) return 'low'; // stale pending item
  return 'normal';
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/** Rule-based recommendation. Pure function — no I/O. */
function decide({ dc, reliability, priority }) {
  const matchCount = (dc && dc.matchCount) || 0;
  const isDup = !!(dc && dc.isDuplicate && matchCount > 0);
  const isSusp = !!(dc && dc.isSuspicious && matchCount > 0);
  const tier = reliability && reliability.tier;
  const relRisk = tier === 'high_risk' || tier === 'review';

  if (isDup) {
    const score = (dc && typeof dc.score === 'number') ? dc.score : 80;
    return {
      recommendation: REC.POSSIBLE_DUPLICATE,
      confidence: clamp01(score / 100),
      reason: `Possible duplicate — score ${score}, ${matchCount} match(es). Human should compare before approving.`,
    };
  }
  if (isSusp || relRisk) {
    const bits = [];
    if (isSusp) bits.push('similar content found');
    if (relRisk) bits.push(`reporter reliability: ${tier}`);
    return {
      recommendation: REC.NEEDS_HUMAN_VERIFICATION,
      confidence: relRisk && isSusp ? 0.72 : 0.62,
      reason: `Needs human verification — ${bits.join('; ')}.`,
    };
  }
  if (priority === 'urgent') {
    return { recommendation: REC.PRIORITY_REVIEW, confidence: 0.6, reason: 'Appears time-sensitive from the headline — review sooner.' };
  }
  if (priority === 'low') {
    return { recommendation: REC.LOW_PRIORITY, confidence: 0.55, reason: 'Older pending item with no risk signals — low priority.' };
  }
  return { recommendation: REC.REVIEW, confidence: 0.5, reason: 'Standard pending item — no risk signals detected.' };
}

/**
 * Run the shadow triage over a small batch.
 * @param {object} opts { limit }
 * @param {object} deps { config, registry, NexaTask, actorId, actorName, now }
 * @returns {Promise<object>} summary — NEVER throws
 */
async function run(opts = {}, deps = {}) {
  const config = deps.config || require('../config').config;
  const registry = deps.registry || require('../tools/registry');
  const NexaTask = deps.NexaTask || require('../../models/NexaTask');
  const now = deps.now || Date.now();

  // Inert unless NEXA is active (enabled + not killed). Production stays inert.
  if (!config.isActive()) {
    return { skipped: true, reason: 'nexa_inactive', analyzed: 0, created: 0, alreadyDone: 0, results: [] };
  }

  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 10, 1), 50); // hard cap 50
  const ctx = { role: 'superadmin', workflow: WORKFLOW, actorId: deps.actorId, actorName: deps.actorName };

  // Two ways to supply the batch:
  //  - opts.items: a caller-selected list (used by the bounded auto-processor so
  //    it can target ONLY not-yet-analysed items and drain the whole backlog).
  //  - otherwise fall back to the existing getPendingTasks tool (oldest first).
  let items;
  if (Array.isArray(opts.items)) {
    items = opts.items.slice(0, limit);
  } else {
    const pendingRes = await registry.run('getPendingTasks', { limit }, ctx);
    if (!pendingRes.ok) {
      return { skipped: true, reason: pendingRes.error || 'getPendingTasks_failed', analyzed: 0, created: 0, alreadyDone: 0, results: [] };
    }
    items = pendingRes.result || [];
  }

  let created = 0;
  let alreadyDone = 0;
  const results = [];

  for (const item of items) {
    try {
      const newsId = String(item._id);

      // Idempotency: skip if this item was already analyzed for this version.
      const exists = await NexaTask.exists({ workflow: WORKFLOW, entityId: newsId, 'aiDecision.version': VERSION });
      if (exists) { alreadyDone++; continue; }

      // --- signals (read-only tools only) ---
      const dupRes = await registry.run('checkDuplicate', { newsId }, ctx);
      const dc = dupRes.ok ? dupRes.result : null;

      let reliability = null;
      if (item.authorId) {
        const relRes = await registry.run('getReporterReliability', { reporterId: String(item.authorId) }, ctx);
        reliability = relRes.ok ? relRes.result : null;
      }

      const priority = estimatePriority(item, now);
      const { recommendation, reason, confidence } = decide({ dc, reliability, priority });

      // --- write ONLY a shadow recommendation record. No production action. ---
      await NexaTask.create({
        workflow: WORKFLOW,
        action: recommendation,
        entityType: 'news',
        entityId: newsId,
        status: 'completed',
        mode: 'shadow',
        autonomyLevel: 0,
        confidence,
        requiresApproval: false,
        reason,
        aiDecision: {
          version: VERSION,
          recommendation,
          priority,
          actionTaken: 'none',
          signals: {
            duplicate: dc
              ? { isDuplicate: !!dc.isDuplicate, isSuspicious: !!dc.isSuspicious, score: dc.score || 0, matchCount: dc.matchCount || 0 }
              : null,
            reliability: reliability ? { score: reliability.score, tier: reliability.tier } : null,
            title: item.title || null,
            language: item.language || null,
            location: item.location || null,
            publishedAt: item.publishedAt || null,
          },
        },
      });

      created++;
      results.push({ newsId, recommendation, confidence });
    } catch (itemErr) {
      // Per-item failure must never abort the batch or touch production.
      // eslint-disable-next-line no-console
      console.warn('[NEXA][triage] item failed (non-fatal):', itemErr && itemErr.message);
    }
  }

  return { skipped: false, analyzed: items.length, created, alreadyDone, results, workflow: WORKFLOW, version: VERSION };
}

module.exports = { run, decide, estimatePriority, WORKFLOW, VERSION, REC };
