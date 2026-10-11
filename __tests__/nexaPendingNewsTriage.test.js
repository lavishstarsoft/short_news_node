'use strict';

const triage = require('../nexa/workflows/pendingNewsTriage');

// Tools the workflow is allowed to call — all read-only.
const READ_ONLY_TOOLS = ['getPendingTasks', 'checkDuplicate', 'getReporterReliability', 'getBacklog'];
// Any of these appearing would mean NEXA tried to act — must NEVER happen.
const FORBIDDEN_TOOLS = ['approveNews', 'rejectNews', 'publishNews', 'createTask', 'updateTaskStatus', 'sendNotification', 'restrictReporter', 'adjustWallet'];

function makeDeps({ active = true, items = [], exists = false } = {}) {
  const toolCalls = [];
  const creates = [];
  return {
    toolCalls,
    creates,
    deps: {
      config: { isActive: () => active },
      registry: {
        run: async (name) => {
          toolCalls.push(name);
          if (name === 'getPendingTasks') return { ok: true, result: items };
          if (name === 'checkDuplicate') return { ok: true, result: { isDuplicate: false, isSuspicious: false, score: 0, matchCount: 0 } };
          if (name === 'getReporterReliability') return { ok: true, result: { score: 90, tier: 'trusted' } };
          return { ok: false, error: 'unknown_tool' };
        },
      },
      NexaTask: {
        exists: async () => exists,
        create: async (doc) => { creates.push(doc); return doc; },
      },
      now: Date.now(),
    },
  };
}

describe('NEXA Pending News Triage — shadow mode', () => {
  test('inert when NEXA is not active (production default)', async () => {
    const { toolCalls, creates, deps } = makeDeps({ active: false, items: [{ _id: 'n1' }] });
    const out = await triage.run({ limit: 10 }, deps);
    expect(out.skipped).toBe(true);
    expect(out.reason).toBe('nexa_inactive');
    expect(toolCalls).toHaveLength(0); // touched nothing
    expect(creates).toHaveLength(0);
  });

  test('creates ONLY shadow NexaTask records, uses ONLY read-only tools', async () => {
    const items = [
      { _id: 'n1', title: 'Council meeting update', authorId: 'r1', publishedAt: new Date() },
      { _id: 'n2', title: 'BREAKING: highway accident', authorId: 'r2', publishedAt: new Date() },
    ];
    const { toolCalls, creates, deps } = makeDeps({ active: true, items });
    const out = await triage.run({ limit: 10 }, deps);

    expect(out.analyzed).toBe(2);
    expect(out.created).toBe(2);
    expect(creates).toHaveLength(2);

    // Every create is a shadow, no-action record.
    for (const c of creates) {
      expect(c.mode).toBe('shadow');
      expect(c.status).toBe('completed');
      expect(c.requiresApproval).toBe(false);
      expect(c.entityType).toBe('news');
      expect(c.aiDecision.actionTaken).toBe('none');
      expect(typeof c.confidence).toBe('number');
      expect(c.reason).toEqual(expect.any(String));
    }

    // Only whitelisted read-only tools were called; nothing that acts.
    for (const name of toolCalls) expect(READ_ONLY_TOOLS).toContain(name);
    for (const forbidden of FORBIDDEN_TOOLS) expect(toolCalls).not.toContain(forbidden);
  });

  test('idempotent — already-analyzed items are skipped, not recreated', async () => {
    const items = [{ _id: 'n1', title: 'x', authorId: 'r1', publishedAt: new Date() }];
    const { creates, deps } = makeDeps({ active: true, items, exists: true });
    const out = await triage.run({ limit: 10 }, deps);
    expect(out.created).toBe(0);
    expect(out.alreadyDone).toBe(1);
    expect(creates).toHaveLength(0);
  });

  test('decide(): duplicate → POSSIBLE_DUPLICATE', () => {
    const r = triage.decide({ dc: { isDuplicate: true, matchCount: 2, score: 92 }, reliability: null, priority: 'normal' });
    expect(r.recommendation).toBe('POSSIBLE_DUPLICATE');
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  test('decide(): suspicious or risky reporter → NEEDS_HUMAN_VERIFICATION', () => {
    expect(triage.decide({ dc: { isSuspicious: true, matchCount: 1 }, reliability: null, priority: 'normal' }).recommendation).toBe('NEEDS_HUMAN_VERIFICATION');
    expect(triage.decide({ dc: null, reliability: { tier: 'high_risk' }, priority: 'normal' }).recommendation).toBe('NEEDS_HUMAN_VERIFICATION');
  });

  test('decide(): urgent → PRIORITY_REVIEW, stale → LOW_PRIORITY, else REVIEW', () => {
    expect(triage.decide({ dc: null, reliability: null, priority: 'urgent' }).recommendation).toBe('PRIORITY_REVIEW');
    expect(triage.decide({ dc: null, reliability: null, priority: 'low' }).recommendation).toBe('LOW_PRIORITY');
    expect(triage.decide({ dc: null, reliability: null, priority: 'normal' }).recommendation).toBe('REVIEW');
  });

  test('estimatePriority(): keyword=urgent, old=low, recent-plain=normal', () => {
    const now = Date.now();
    expect(triage.estimatePriority({ title: 'BREAKING fire in market', publishedAt: new Date(now) }, now)).toBe('urgent');
    expect(triage.estimatePriority({ title: 'routine notice', publishedAt: new Date(now - 72 * 3600000) }, now)).toBe('low');
    expect(triage.estimatePriority({ title: 'routine notice', publishedAt: new Date(now) }, now)).toBe('normal');
  });
});
