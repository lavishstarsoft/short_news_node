'use strict';

/**
 * View Distribution Engine — unit + worker + performance tests.
 * Pure modules and dependency-injected components only (no live DB required).
 */

// Stub the shared Redis client so importing the engine never opens a real
// connection (keeps Jest exiting cleanly under the existing `npm test` script).
jest.mock('../config/redis', () => ({
  redisClient: { on() {}, connect: async () => {}, quit: async () => {}, disconnect: async () => {} },
  isRedisAvailable: () => false,
  recordCacheHit() {},
  recordCacheMiss() {},
  getCacheStats: () => ({}),
  resetCacheStats() {},
  warmCache: async () => {},
  closeRedisConnection: async () => {}
}));

const curve = require('../services/viewDistribution/curve');
const allocator = require('../services/viewDistribution/allocator');
const signalProvider = require('../services/viewDistribution/signalProvider');
require('../services/viewDistribution/strategy/AdaptiveStrategy');
const { resolveStrategy } = require('../services/viewDistribution/strategy/AllocationStrategy');
const ticker = require('../services/viewDistribution/ticker');
const queue = require('../services/viewDistribution/queue');
const worker = require('../services/viewDistribution/worker');

const HOUR = 3600000;

// The engine transitively imports the shared redis client; close it so Jest exits.
afterAll(async () => {
  try {
    await require('../config/redis').closeRedisConnection();
  } catch (_) {
    /* ignore */
  }
});

describe('curve (Beta CDF)', () => {
  test('boundaries F(0)=0, F(T)=1', () => {
    expect(curve.cumulativeFraction(0, HOUR)).toBe(0);
    expect(curve.cumulativeFraction(HOUR, HOUR)).toBe(1);
  });
  test('Beta(1,1) is linear', () => {
    expect(curve.cumulativeFraction(HOUR / 2, HOUR, { alpha: 1, beta: 1 })).toBeCloseTo(0.5, 6);
  });
  test('Beta(2,3) is front-loaded (analytic 0.6875 at halfway)', () => {
    expect(curve.cumulativeFraction(HOUR / 2, HOUR)).toBeCloseTo(0.6875, 4);
  });
  test('monotonic non-decreasing', () => {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const f = curve.cumulativeFraction((HOUR * i) / 20, HOUR);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });
  test('expectedCumulative anchors to elapsed time (self-correcting)', () => {
    expect(curve.expectedCumulative(1000, HOUR / 2, HOUR)).toBeCloseTo(687.5, 1);
  });
  test('guards: total<=0 => 1, elapsed<0 => 0; deterministic', () => {
    expect(curve.cumulativeFraction(10, 0)).toBe(1);
    expect(curve.cumulativeFraction(-5, HOUR)).toBe(0);
    expect(curve.cumulativeFraction(HOUR / 3, HOUR)).toBe(curve.cumulativeFraction(HOUR / 3, HOUR));
  });
});

describe('allocator', () => {
  const campaign = {
    minViews: 1000,
    maxViews: 2000,
    budgetProtection: { maxItemSharePct: 40 },
    diversity: { enabled: false },
    durationMinutes: 60,
    curve: { burstAlpha: 2, taperBeta: 3, jitterPct: 0.15, maxStepMultiplier: 4 },
    cooldown: { enabled: true, restCycles: 2 }
  };

  test('allocateTargets: weight-monotonic band (diversity off) + monotonic cap floor', () => {
    const decision = { decisions: [{ itemId: 'a', weight: 1 }, { itemId: 'b', weight: 0.5 }, { itemId: 'c', weight: 0.1 }] };
    const states = [
      { itemId: 'a', deliveredTotal: 0, bucket: {} },
      { itemId: 'b', deliveredTotal: 0, bucket: {} },
      { itemId: 'c', deliveredTotal: 900, bucket: {} } // already delivered
    ];
    const bands = allocator.allocateTargets({ decision, states, campaign });
    const m = Object.fromEntries(bands.map((x) => [x.itemId, x]));
    expect(m.a.cap).toBeGreaterThanOrEqual(m.b.cap);
    expect(m.b.cap).toBeGreaterThanOrEqual(m.c.cap);
    // MONOTONIC: never below already delivered
    expect(m.c.cap).toBeGreaterThanOrEqual(900);
  });

  test('computeCycleDeltas: cooldown => 0, cap never exceeded, delta>=0, max-step bound, idempotent', () => {
    const states = [
      { itemId: 'x', cap: 2000, floor: 1000, deliveredTotal: 0, cooldownUntilCycle: 0, bucket: {} },
      { itemId: 'rest', cap: 2000, floor: 1000, deliveredTotal: 100, cooldownUntilCycle: 8, bucket: {} }, // resting
      { itemId: 'full', cap: 1500, floor: 1000, deliveredTotal: 1500, cooldownUntilCycle: 0, bucket: {} } // capped
    ];
    const timing = { cycleIndex: 6, elapsedMs: (HOUR * 6) / 60, totalMs: HOUR };
    const r1 = allocator.computeCycleDeltas({ states, campaign, timing });
    const d = Object.fromEntries(r1.deltas.map((x) => [x.itemId, x]));
    expect(d.rest.delta).toBe(0); // cooldown
    expect(d.full.delta).toBe(0); // cap reached, never negative
    r1.deltas.forEach((x) => {
      const st = states.find((s) => s.itemId === x.itemId);
      expect(x.delta).toBeGreaterThanOrEqual(0); // monotonic
      expect(x.newDeliveredTotal).toBeLessThanOrEqual(st.cap); // cap
      expect(x.delta).toBeLessThanOrEqual(Math.max(1, (st.cap / 60) * 4) + 0.001); // max-step
    });
    // IDEMPOTENT: recomputing the same cycle is byte-identical (seeded jitter)
    const r2 = allocator.computeCycleDeltas({ states, campaign, timing });
    expect(JSON.stringify(r1.deltas)).toBe(JSON.stringify(r2.deltas));
  });

  test('diversity rebalances across buckets (hard clamp)', () => {
    const decision = { decisions: [{ itemId: 'a', weight: 1 }, { itemId: 'b', weight: 0.9 }, { itemId: 'c', weight: 0.1 }] };
    const states = [
      { itemId: 'a', deliveredTotal: 0, bucket: { category: 'p', region: 'AP', publisher: 'r1' } },
      { itemId: 'b', deliveredTotal: 0, bucket: { category: 'p', region: 'AP', publisher: 'r1' } },
      { itemId: 'c', deliveredTotal: 0, bucket: { category: 's', region: 'TS', publisher: 'r2' } }
    ];
    const camp = { ...campaign, diversity: { enabled: true, dimensions: ['category', 'region', 'publisher'], maxBucketSharePct: 50 } };
    const bands = allocator.allocateTargets({ decision, states, campaign: camp });
    const m = Object.fromEntries(bands.map((x) => [x.itemId, x.cap]));
    // lone bucket 'c' retains budget while the crowded p/AP/r1 pair is damped
    expect(m.c).toBeGreaterThan(0);
  });
});

describe('AdaptiveStrategy', () => {
  const base = { intensity: 'balanced', cooldown: { enabled: true }, budgetProtection: { maxItemSharePct: 40 }, diversity: { enabled: true, maxBucketSharePct: 50 } };
  const fv = [
    { itemId: 'a', bucket: { category: 'p', region: 'AP', publisher: 'r1' }, features: { freshness: 1, engagement: 1, velocity: 1, scopeWeight: 1, categoryWeight: 1, breaking: 1, priority: 0.5 } },
    { itemId: 'b', bucket: { category: 's', region: 'TS', publisher: 'r2' }, features: { freshness: 0.1, engagement: 0, velocity: 0, scopeWeight: 1, categoryWeight: 1, breaking: 0, priority: 0 } }
  ];

  test('intensity changes coefficients (aggressive != balanced)', () => {
    const bal = resolveStrategy('adaptive').decide(fv, { campaign: base, cycleIndex: 1 });
    const agg = resolveStrategy('adaptive').decide(fv, { campaign: { ...base, intensity: 'aggressive' }, cycleIndex: 1 });
    expect(bal.decisions[0].weight).not.toBeCloseTo(agg.decisions[0].weight, 6);
  });

  test('cooldown + budget inputs zero weights; deterministic; inputs intact', () => {
    const ctx = { campaign: base, cycleIndex: 5, cooldownByItem: { a: 10 }, budgetByItem: { b: { remaining: 0 } } };
    const out = resolveStrategy('adaptive').decide(fv, ctx);
    const w = Object.fromEntries(out.decisions.map((d) => [d.itemId, d.weight]));
    expect(w.a).toBe(0); // cooldown
    expect(w.b).toBe(0); // budget exhausted
    const out2 = resolveStrategy('adaptive').decide(fv, ctx);
    expect(JSON.stringify(out.decisions)).toBe(JSON.stringify(out2.decisions));
    expect(fv[0].features.freshness).toBe(1); // not mutated
  });
});

describe('signalProvider (pure)', () => {
  test('minMaxNormalize: uniform=>0.5, spread=>0..1', () => {
    expect(signalProvider.minMaxNormalize([5, 5, 5])).toEqual([0.5, 0.5, 0.5]);
    expect(signalProvider.minMaxNormalize([0, 5, 10])).toEqual([0, 0.5, 1]);
  });
  test('computeFeatureVectors: freshness, velocity, buckets; empty=>[]', () => {
    const now = new Date();
    const docs = [
      { _id: 'a', category: 'p', location: 'AP', scope: 'state', publishedAt: now, likes: 10, comments: 5, views: 100, authorId: 'r1' },
      { _id: 'b', category: 's', location: 'TS', scope: 'national', publishedAt: new Date(now - 48 * HOUR), likes: 0, comments: 0, views: 0, authorId: 'r2' }
    ];
    const prior = new Map([['a', { organicBaseline: 60, lastRebalanceAt: new Date(now - 10 * 60000) }]]);
    const out = signalProvider.computeFeatureVectors(docs, { now, priorStateById: prior });
    const a = out.find((x) => x.itemId === 'a');
    expect(a.features.freshness).toBeGreaterThan(0.9);
    expect(a.features.velocity).toBe(1); // only item with positive organic velocity
    expect(a.bucket).toEqual({ category: 'p', region: 'AP', publisher: 'r1' });
    expect(signalProvider.computeFeatureVectors([])).toEqual([]);
  });
});

describe('displayViews (centralized helper)', () => {
  test('OFF (default) returns organic only — byte-identical', () => {
    const { displayViews } = require('../services/viewDistribution/displayViews');
    expect(displayViews({ views: 320, syntheticViews: 180 })).toBe(320);
    expect(displayViews({})).toBe(0);
  });
  test('ON combines organic + synthetic', () => {
    jest.isolateModules(() => {
      jest.doMock('../services/viewDistribution/config', () => ({
        isEnabledCached: () => true,
        startFlagWatcher() {},
        refreshEnabled: async () => true
      }));
      const { displayViews } = require('../services/viewDistribution/displayViews');
      expect(displayViews({ views: 320, syntheticViews: 180 })).toBe(500);
      jest.dontMock('../services/viewDistribution/config');
    });
  });
});

describe('ticker.planCycle (lifecycle)', () => {
  const MIN = 60000;
  const now = Date.now();
  test('mid-run enqueues correct cycleIndex', () => {
    expect(ticker.planCycle({ startAt: new Date(now - 5 * MIN), durationMinutes: 60 }, now)).toEqual({ action: 'enqueue', cycleIndex: 5 });
  });
  test('not-started => skip', () => {
    expect(ticker.planCycle({ startAt: new Date(now + 10 * MIN), durationMinutes: 60 }, now).action).toBe('skip');
  });
  test('past duration/end => complete', () => {
    expect(ticker.planCycle({ startAt: new Date(now - 65 * MIN), durationMinutes: 60 }, now).action).toBe('complete');
    expect(ticker.planCycle({ startAt: new Date(now - 5 * MIN), durationMinutes: 60, endAt: new Date(now - MIN) }, now).action).toBe('complete');
  });
});

describe('queue.parseJob (pure)', () => {
  test('valid parses; missing/invalid => null', () => {
    expect(queue.parseJob({ id: '1-0', message: { campaignId: 'C', cycleIndex: '5', enqueuedAt: '123' } })).toEqual({ id: '1-0', campaignId: 'C', cycleIndex: 5, enqueuedAt: 123 });
    expect(queue.parseJob({ id: '1-0', message: { cycleIndex: '5' } })).toBeNull();
    expect(queue.parseJob({ id: '1-0', message: { campaignId: 'C', cycleIndex: 'x' } })).toBeNull();
  });
});

describe('worker (injected queue) — ack / retry / isolation', () => {
  test('acks success, leaves failures pending, isolates errors, drains on stop', async () => {
    const acked = [];
    let calls = 0;
    const fakeQueue = {
      consume: async () => {
        calls++;
        return calls === 1
          ? [{ id: '1', campaignId: 'C', cycleIndex: 1 }, { id: '2', campaignId: 'C', cycleIndex: 2 }, { id: '3', campaignId: 'C', cycleIndex: 3 }]
          : [];
      },
      ack: async (id) => { acked.push(id); },
      reclaim: async () => []
    };
    const handler = async (job) => { if (job.id === '2') throw new Error('boom'); };
    worker.start({ handler, queue: fakeQueue, consumerName: 't', pollIntervalMs: 10, reclaimIntervalMs: 100000 });
    await new Promise((r) => setTimeout(r, 90));
    await worker.stop();
    const m = worker.getMetrics();
    expect(acked.sort()).toEqual(['1', '3']); // failed '2' NOT acked
    expect(m.succeeded).toBe(2);
    expect(m.failed).toBe(1);
    expect(worker.isRunning()).toBe(false);
  });
});

describe('performance (millions-scale per cycle is O(itemCap))', () => {
  test('computeCycleDeltas over 10k items completes fast', () => {
    const states = Array.from({ length: 10000 }, (_, i) => ({
      itemId: String(i), cap: 2000, floor: 1000, deliveredTotal: i % 2 ? 0 : 500, cooldownUntilCycle: 0, bucket: {}
    }));
    const campaign = { durationMinutes: 60, curve: { jitterPct: 0.15, maxStepMultiplier: 4 }, cooldown: { enabled: true, restCycles: 2 } };
    const t0 = Date.now();
    const r = allocator.computeCycleDeltas({ states, campaign, timing: { cycleIndex: 5, elapsedMs: 300000, totalMs: HOUR } });
    const ms = Date.now() - t0;
    expect(r.deltas.length).toBe(10000);
    expect(ms).toBeLessThan(1000);
  });
});
