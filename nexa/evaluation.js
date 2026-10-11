'use strict';

/**
 * TEHELKA NEXA — Accuracy/Evaluation (pure, read-only helpers).
 *
 * Compares NEXA shadow recommendations (from NexaTask) with the EVENTUAL human
 * outcome of the same news item (read from the News document's own state — set
 * by the existing approval workflow, NOT by NEXA). No writes, no workflow change.
 *
 * "Concern" recommendations (POSSIBLE_DUPLICATE, NEEDS_HUMAN_VERIFICATION) are
 * treated as NEXA raising a flag; the human "ground truth" is whether they then
 * rejected (flag justified) or approved (flag was a false alarm). Neutral
 * recommendations (PRIORITY_REVIEW/LOW_PRIORITY/REVIEW) are not predictions of
 * reject/approve, so they only affect the matrix, never precision/recall.
 * Items with no human decision yet are counted as "pending" and excluded from
 * agreement/precision/recall.
 */

const CONCERN = new Set(['POSSIBLE_DUPLICATE', 'NEEDS_HUMAN_VERIFICATION']);

/** Map a News document's current state → the human outcome. Read-only. */
function deriveOutcome(newsDoc) {
  if (!newsDoc) return 'unknown';
  if (newsDoc.rejectionStatus && newsDoc.rejectionStatus.isRejected) return 'rejected';
  if (newsDoc.isActive === true || (newsDoc.approvalStatus && newsDoc.approvalStatus.isApproved)) return 'approved';
  if (newsDoc.isDeactivated === true) return 'removed';
  return 'pending';
}

/**
 * @param {Array} tasks  shadow NexaTask docs ({entityId, action, confidence, createdAt, reason})
 * @param {Object} outcomeById  { [newsId]: 'approved'|'rejected'|'pending'|'removed'|'unknown' }
 * @param {number} recentLimit
 */
function buildEvaluation(tasks, outcomeById, recentLimit = 15) {
  const matrix = {}; // recommendation -> { approved, rejected, pending, removed, unknown, total }
  let tp = 0, fp = 0, tn = 0, fn = 0, decided = 0, pending = 0;
  const recent = [];

  for (const t of tasks || []) {
    const rec = t.action || 'UNKNOWN';
    const outcome = (outcomeById && outcomeById[String(t.entityId)]) || 'pending';
    if (!matrix[rec]) matrix[rec] = { approved: 0, rejected: 0, pending: 0, removed: 0, unknown: 0, total: 0 };
    matrix[rec][outcome] = (matrix[rec][outcome] || 0) + 1;
    matrix[rec].total += 1;

    const flagged = CONCERN.has(rec);
    let agree = null;
    if (outcome === 'approved' || outcome === 'rejected') {
      decided += 1;
      if (flagged && outcome === 'rejected') { tp += 1; agree = true; }
      else if (flagged && outcome === 'approved') { fp += 1; agree = false; }
      else if (!flagged && outcome === 'approved') { tn += 1; agree = true; }
      else if (!flagged && outcome === 'rejected') { fn += 1; agree = false; }
    } else {
      pending += 1;
    }

    if (recent.length < recentLimit) {
      recent.push({
        entityId: t.entityId,
        recommendation: rec,
        confidence: t.confidence != null ? t.confidence : null,
        outcome,
        agree, // true | false | null(pending)
        createdAt: t.createdAt || null,
      });
    }
  }

  const agreement = decided ? Math.round(((tp + tn) / decided) * 100) : null;
  const flagPrecision = (tp + fp) ? Math.round((tp / (tp + fp)) * 100) : null;
  const flagRecall = (tp + fn) ? Math.round((tp / (tp + fn)) * 100) : null;

  return {
    totalCompared: (tasks || []).length,
    decided,
    pending,
    tp, fp, tn, fn,
    agreement,        // over decided items only
    flagPrecision,    // of flagged items that humans rejected
    flagRecall,       // of human-rejected items that NEXA had flagged
    matrix,
    recent,
  };
}

module.exports = { CONCERN, deriveOutcome, buildEvaluation };
