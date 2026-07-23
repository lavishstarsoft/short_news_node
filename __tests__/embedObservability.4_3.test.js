'use strict';

const {
  createEmbedWorkerMetrics,
  createNewsVectorQueueMetrics,
  createEmbedPipelineHealth,
  STATUS,
} = require('../services/aiDuplicate/semantic');

describe('Phase-4.3 observability metrics', () => {
  test('worker metrics emit claimed, ready, retry, failed, skipped, reclaim, latencies', () => {
    const m = createEmbedWorkerMetrics({ now: () => 1000 });
    m.recordClaimed(2);
    m.recordReclaim(1);
    m.recordClaimLatency(12);
    m.recordEmbedLatency(40);
    m.recordSuccess(50);
    m.recordRetry('embed_http_503');
    m.recordFailure('boom', 60);
    m.recordSkipped('already_ready');
    m.recordBatch();

    const s = m.snapshot();
    expect(s.claimed).toBe(2);
    expect(s.reclaims).toBe(1);
    expect(s.leaseExpirations).toBe(1);
    expect(s.ready).toBe(1);
    expect(s.success).toBe(1);
    expect(s.retry).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.failure).toBe(1);
    expect(s.skipped).toBe(1);
    expect(s.skippedUnchanged).toBe(1);
    expect(s.completed).toBe(4); // success+retry+failure+skipped
    expect(s.batches).toBe(1);
    expect(s.avgClaimLatencyMs).toBe(12);
    expect(s.avgEmbedLatencyMs).toBe(40);
    expect(s.avgE2eLatencyMs).toBe(55); // (50+60)/2
    expect(s.lastErrorCode).toBe('already_ready');
    expect(s.recentErrors.length).toBeGreaterThan(0);
  });

  test('queue metrics snapshot counts and oldest PENDING age', async () => {
    const counts = { PENDING: 3, READY: 10, FAILED: 2, STALE: 0 };
    let clock = 10_000;
    const NewsVector = {
      countDocuments: async (filter) => counts[filter.status] || 0,
      findOne() {
        const api = {
          sort() {
            return api;
          },
          lean: async () => ({
            status: STATUS.PENDING,
            createdAt: new Date(1000),
            updatedAt: new Date(1000),
          }),
        };
        return api;
      },
    };

    const q = createNewsVectorQueueMetrics({
      NewsVector,
      now: () => clock,
    });
    const snap = await q.snapshot();
    expect(snap.pending).toBe(3);
    expect(snap.ready).toBe(10);
    expect(snap.failed).toBe(2);
    expect(snap.stale).toBe(0);
    expect(snap.queueDepth).toBe(3);
    expect(snap.oldestPendingAgeMs).toBe(9000);
    expect(snap.error).toBeNull();
  });

  test('health report summarizes worker, queue, AI, errors', async () => {
    const metrics = createEmbedWorkerMetrics({ now: () => 1 });
    metrics.recordFailure('embed_http_503', 10);
    metrics.recordRetry('timeout');

    const health = createEmbedPipelineHealth({
      env: { AI_EMBED_WORKER_ENABLED: 'false' },
      metrics,
      queueMetrics: {
        snapshot: async () => ({
          pending: 5,
          ready: 100,
          failed: 1,
          stale: 0,
          queueDepth: 5,
          oldestPendingAgeMs: 120000,
          oldestPendingAt: new Date().toISOString(),
          error: null,
        }),
      },
      checkAi: async () => ({
        ok: true,
        reachable: true,
        reason: 'ready',
        status: 200,
      }),
      now: () => 1,
    });

    const report = await health.getHealthReport();
    expect(report.worker.enabled).toBe(false);
    expect(report.queue.queueDepth).toBe(5);
    expect(report.ai.connectivity).toBe('up');
    expect(report.recentErrorCounts.failures).toBe(1);
    expect(report.recentErrorCounts.retries).toBe(1);
    expect(report.summary.queueDepth).toBe(5);
    expect(report.summary.aiConnectivity).toBe('up');
    expect(report.phase).toBe('4.3');
  });

  test('health report fail-open when AI check throws', async () => {
    const health = createEmbedPipelineHealth({
      env: {},
      metrics: createEmbedWorkerMetrics(),
      queueMetrics: {
        snapshot: async () => ({
          pending: 0,
          ready: 0,
          failed: 0,
          stale: 0,
          queueDepth: 0,
          oldestPendingAgeMs: null,
          error: null,
        }),
      },
      checkAi: async () => {
        throw new Error('network');
      },
    });
    const report = await health.getHealthReport();
    expect(report.ai.connectivity).toBe('down');
    expect(report.ai.ok).toBe(false);
  });
});
