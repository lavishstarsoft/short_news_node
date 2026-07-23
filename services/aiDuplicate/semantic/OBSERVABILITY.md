# Embedding Pipeline Observability — Phase-4.3

Operational visibility only. Does **not** change duplicate detection, gateway, or advisory logic.

## Metric definitions

### Worker counters (in-process)

| Metric | Meaning |
|--------|---------|
| `claimed` | Jobs successfully lease-claimed |
| `completed` | Jobs finished any terminal/retry/skip path |
| `ready` / `success` | Transitions to READY |
| `failed` / `failure` | Transitions to FAILED |
| `retry` | Soft-fail; stays PENDING with backoff |
| `skipped` | All skip reasons |
| `skippedUnchanged` | Idempotent READY / unchanged skips |
| `leaseExpirations` | Same as reclaims (expired lease taken) |
| `reclaims` | Claims that recovered an expired lease |
| `batches` | `processBatch` invocations |

### Latency

| Metric | Meaning |
|--------|---------|
| `avgClaimLatencyMs` | Time to claim a batch |
| `avgEmbedLatencyMs` | `/v1/embed` call duration |
| `avgE2eLatencyMs` | Claimed job start → READY/FAILED complete |
| `avgLatencyMs` | Alias of embed/e2e success-failure average (compat) |

### Queue (Mongo `news_vectors`)

| Metric | Meaning |
|--------|---------|
| `pending` | Count `status=PENDING` |
| `ready` | Count `status=READY` |
| `failed` | Count `status=FAILED` |
| `stale` | Count `status=STALE` (usually near 0; STALE is brief) |
| `queueDepth` | Alias of `pending` |
| `oldestPendingAgeMs` | Age of oldest PENDING by `createdAt` |
| `oldestPendingAt` | ISO timestamp of that row |

### Health report (`getHealthReport`)

| Field | Meaning |
|-------|---------|
| `worker.enabled` | `AI_EMBED_WORKER_ENABLED` |
| `worker.running` | Poll timer active in this process |
| `queue.*` | Queue snapshot |
| `ai.connectivity` | `up` / `down` via `/readyz` (force) |
| `recentErrorCounts` | Failures, retries, last codes |
| `summary.healthy` | Heuristic: queue readable; if worker enabled then running |

Access (Node):

```js
const { createEmbedPipelineHealth } = require('./services/aiDuplicate/semantic');
const health = createEmbedPipelineHealth();
const report = await health.getHealthReport();
```

Optional script: `node scripts/embed-pipeline-health.js`

---

## Dashboard recommendations

### Row 1 — Status
- Worker enabled (bool)
- Worker running (bool)
- AI connectivity (up/down)
- Queue depth (PENDING)

### Row 2 — Throughput (rate / 5m)
- Claimed / min
- READY / min
- FAILED / min
- Retries / min
- Reclaims / min

### Row 3 — Latency
- Claim p50/p95 (use avg until histograms exist)
- Embed p50/p95
- E2E p50/p95

### Row 4 — Backlog health
- PENDING count
- Oldest PENDING age (alert if > 30–60 min when worker ON)
- FAILED count (alert on spike)

### Row 5 — Errors
- `lastErrorCode` timeline
- Recent error list (codes only — no article text)

---

## Operational troubleshooting

| Symptom | Checks | Actions |
|---------|--------|---------|
| PENDING grows, READY flat | Worker enabled? Running? AI up? | Set `AI_EMBED_WORKER_ENABLED=true`, restart; verify AI `/readyz` |
| High FAILED | `lastErrorCode`, AI logs | Fix AI/key/timeouts; reset FAILED→PENDING manually if needed |
| High retries | Embed 5xx/timeouts | Scale AI; raise timeout carefully |
| High reclaims | Workers crashing or lease too short | Raise `AI_EMBED_WORKER_LEASE_MS`; check OOM/restarts |
| Oldest PENDING age high | Worker off or stuck claims | Enable worker; wait for lease expiry; check claim indexes |
| AI down in health | URL/key/`/readyz` | Restore ai-service; embed worker will retry |

**Rollback observability:** remove health script / stop scraping metrics; pipeline behavior unchanged if metrics modules unused.
