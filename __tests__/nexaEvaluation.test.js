'use strict';

const { deriveOutcome, buildEvaluation } = require('../nexa/evaluation');

describe('NEXA evaluation (read-only)', () => {
  test('deriveOutcome maps News state correctly', () => {
    expect(deriveOutcome({ rejectionStatus: { isRejected: true } })).toBe('rejected');
    expect(deriveOutcome({ isActive: true })).toBe('approved');
    expect(deriveOutcome({ approvalStatus: { isApproved: true } })).toBe('approved');
    expect(deriveOutcome({ isDeactivated: true })).toBe('removed');
    expect(deriveOutcome({ isActive: false })).toBe('pending');
    expect(deriveOutcome(null)).toBe('unknown');
  });

  test('buildEvaluation computes matrix + confusion + rates', () => {
    const tasks = [
      { entityId: 'a', action: 'POSSIBLE_DUPLICATE', confidence: 0.9 }, // flagged → rejected = TP
      { entityId: 'b', action: 'POSSIBLE_DUPLICATE', confidence: 0.8 }, // flagged → approved = FP
      { entityId: 'c', action: 'REVIEW', confidence: 0.5 },             // neutral → approved = TN
      { entityId: 'd', action: 'LOW_PRIORITY', confidence: 0.55 },      // neutral → rejected = FN
      { entityId: 'e', action: 'NEEDS_HUMAN_VERIFICATION', confidence: 0.7 }, // pending (excluded)
    ];
    const outcomeById = { a: 'rejected', b: 'approved', c: 'approved', d: 'rejected', e: 'pending' };
    const ev = buildEvaluation(tasks, outcomeById);

    expect(ev.totalCompared).toBe(5);
    expect(ev.decided).toBe(4);
    expect(ev.pending).toBe(1);
    expect(ev).toMatchObject({ tp: 1, fp: 1, tn: 1, fn: 1 });
    expect(ev.agreement).toBe(50); // (tp+tn)/decided = 2/4
    expect(ev.flagPrecision).toBe(50); // tp/(tp+fp) = 1/2
    expect(ev.flagRecall).toBe(50); // tp/(tp+fn) = 1/2
    expect(ev.matrix.POSSIBLE_DUPLICATE.total).toBe(2);
    expect(ev.matrix.POSSIBLE_DUPLICATE.rejected).toBe(1);
    expect(ev.matrix.POSSIBLE_DUPLICATE.approved).toBe(1);
    expect(ev.recent).toHaveLength(5);
  });

  test('no decided items → rates are null (not divide-by-zero)', () => {
    const tasks = [{ entityId: 'x', action: 'LOW_PRIORITY', confidence: 0.55 }];
    const ev = buildEvaluation(tasks, { x: 'pending' });
    expect(ev.decided).toBe(0);
    expect(ev.pending).toBe(1);
    expect(ev.agreement).toBeNull();
    expect(ev.flagPrecision).toBeNull();
    expect(ev.flagRecall).toBeNull();
  });
});
