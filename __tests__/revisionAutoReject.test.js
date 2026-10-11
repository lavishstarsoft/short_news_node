'use strict';

const {
  isEnabled,
  deadlineMinutes,
  buildAutoRejectReason,
  staleQuery,
  runAutoRejectStaleRevisions,
} = require('../services/revisionAutoReject');

describe('revision auto-reject — config', () => {
  test('enabled by default; only explicit false disables', () => {
    expect(isEnabled({})).toBe(true);
    expect(isEnabled({ REVISION_AUTO_REJECT_ENABLED: 'true' })).toBe(true);
    expect(isEnabled({ REVISION_AUTO_REJECT_ENABLED: 'false' })).toBe(false);
    expect(isEnabled({ REVISION_AUTO_REJECT_ENABLED: '0' })).toBe(false);
  });
  test('deadline defaults to 30 and is env-configurable', () => {
    expect(deadlineMinutes({})).toBe(30);
    expect(deadlineMinutes({ REVISION_AUTO_REJECT_MINUTES: '15' })).toBe(15);
    expect(deadlineMinutes({ REVISION_AUTO_REJECT_MINUTES: 'x' })).toBe(30);
  });
});

describe('revision auto-reject — reason + query', () => {
  test('solid English reason mentions the deadline and asks for a fresh submit', () => {
    const { reason, feedback } = buildAutoRejectReason(new Date('2026-09-11T04:00:00Z'), 30);
    expect(reason).toBe('No Response to Revision Request');
    expect(feedback).toMatch(/within 30 minutes/);
    expect(feedback).toMatch(/automatically rejected/i);
    expect(feedback).toMatch(/submit the article again/i);
  });

  test('staleQuery only targets unanswered, past-deadline, not-yet-rejected, unpublished', () => {
    const now = Date.parse('2026-09-11T10:00:00Z');
    const q = staleQuery(now, 30 * 60 * 1000, 24 * 60 * 60 * 1000);
    expect(q['revisionStatus.needsRevision']).toBe(true);
    expect(q['rejectionStatus.isRejected']).toEqual({ $ne: true });
    expect(q.isActive).toEqual({ $ne: true });
    expect(q.isDeactivated).toEqual({ $ne: true });
    expect(q['revisionStatus.sentAt'].$lte).toEqual(new Date(now - 30 * 60 * 1000));
    expect(q['revisionStatus.sentAt'].$gte).toEqual(new Date(now - 24 * 60 * 60 * 1000));
  });

  test('staleQuery without maxAge has no lower bound (backlog sweep mode)', () => {
    const now = Date.parse('2026-09-11T10:00:00Z');
    const q = staleQuery(now, 30 * 60 * 1000);
    expect(q['revisionStatus.sentAt'].$gte).toBeUndefined();
  });
});

describe('revision auto-reject — pass (mocked News)', () => {
  const now = Date.parse('2026-09-11T10:00:00Z');
  function makeNews(candidates, { failId } = {}) {
    const calls = [];
    return {
      calls,
      find() {
        const chain = {
          select() { return chain; },
          sort() { return chain; },
          limit() { return chain; },
          lean: async () => candidates,
        };
        return chain;
      },
      async findOneAndUpdate(filter, update) {
        calls.push({ filter, update });
        const id = String(filter._id);
        if (id === failId) return null; // simulate resubmit-won race
        const doc = candidates.find((c) => String(c._id) === id);
        return { _id: id, authorId: doc.authorId, title: doc.title, rejectionStatus: update.rejectionStatus };
      },
    };
  }

  const stale = [
    { _id: 'A', title: 'Late one', authorId: 'r1', revisionStatus: { needsRevision: true, sentAt: new Date(now - 40 * 60000), revisionCount: 1 }, actionHistory: [] },
    { _id: 'B', title: 'Also late', authorId: 'r2', revisionStatus: { needsRevision: true, sentAt: new Date(now - 31 * 60000), revisionCount: 0 }, actionHistory: [] },
  ];

  test('dry run reports candidates and writes nothing', async () => {
    const News = makeNews(stale);
    const r = await runAutoRejectStaleRevisions({ News, now, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.candidates).toBe(2);
    expect(News.calls).toHaveLength(0);
  });

  test('rejects each with an atomic revisionCount-fingerprinted filter + reason', async () => {
    const News = makeNews(stale);
    const io = { to: () => ({ emit() {} }), emit() {} };
    const r = await runAutoRejectStaleRevisions({ News, io, now });
    expect(r.rejected).toBe(2);
    expect(News.calls).toHaveLength(2);
    const f = News.calls[0].filter;
    expect(f['revisionStatus.needsRevision']).toBe(true);
    expect(f['revisionStatus.revisionCount']).toBe(1);
    expect(f['rejectionStatus.isRejected']).toEqual({ $ne: true });
    expect(News.calls[0].update.rejectionStatus.isRejected).toBe(true);
    expect(News.calls[0].update.rejectionStatus.reason).toBe('No Response to Revision Request');
    expect(News.calls[0].update['revisionStatus.needsRevision']).toBe(false);
  });

  test('a resubmit winning the race is skipped, not counted', async () => {
    const News = makeNews(stale, { failId: 'B' });
    const r = await runAutoRejectStaleRevisions({ News, now });
    expect(r.rejected).toBe(1);
    expect(r.skipped).toBe(1);
  });
});
