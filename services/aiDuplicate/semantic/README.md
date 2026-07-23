# Phase-3B.1 — Semantic infrastructure (docs only in this phase)

## Locked rules

- AI never knows MongoDB. AI returns embeddings only (later phases).
- Node validates and writes `news_vectors`.
- `AI_SEMANTIC_ENABLED` default **false** — does nothing until 3B.6.
- Exact → Near → Semantic funnel (Semantic not wired yet).

## Status values

| Status | Meaning |
|--------|---------|
| `PENDING` | Embed job planned / in flight |
| `READY` | Valid embedding stored |
| `FAILED` | Embed attempt failed |
| `STALE` | `contentHash` changed; must re-embed |

## Lifecycle (planned — not executed in 3B.1)

```text
News create/update (future)
  → contentHash change detected
  → existing READY/PENDING vector → STALE
  → upsert news_vectors status=PENDING
  → build embed job payload (queue port rejects execute in 3B.1)

Phase-3B.2+
  → AI /v1/embed returns vector (no DB)

Phase-3B.3
  → Node validates → READY | FAILED
```

## Modules

- `flags.js` — `AI_SEMANTIC_ENABLED`
- `statuses.js` / `newsVectorContract.js` — document shape
- `embedJobContract.js` — job payload + non-executing queue port
- `lifecycle.js` — `planContentHashChange()` plans only
- `Node/models/NewsVector.js` — Mongoose model (unused by request path)

## Phase-3B.3 — Node persistence

- `embedResponseValidator.js` — validate `/v1/embed` before write
- `newsVectorPersistence.js` — Node-only Mongo writes (`ensurePending`, READY/FAILED/STALE)
- contentHash change → `markStale` → `PENDING` + prepared job (**not enqueued**)
- Still **not** wired to newsController / gateway / Redis workers

## Phase-3B.4 — Atlas Vector Search ONLY

- `vectorSearchService.js` — Embedding → `$vectorSearch` → Top-K matches
- Filters always: `status=READY`, `language`, `embeddingVersion`, `publishedAt` window (default 72h)
- Returns only: `newsId`, `score`, `publishedAt`, `language`, `embeddingVersion`
- Does **not** decide duplicates / merge Exact-Near / call controllers
- Index checklist: `ATLAS_VECTOR_INDEX.md` (manual Atlas apply — never auto-create)

## Phase-3B.5 — Semantic Shadow Mode ONLY

- Flag: `AI_SEMANTIC_SHADOW_ENABLED` default **false**
- `semanticShadowService.js` — Exact + Near + Semantic → compare → metrics
- Persists only to `semantic_shadow_metrics` (never News / duplicateCheck / Reporter)
- Gateway may fire-and-forget schedule when flag ON — **return value unchanged**
- Logs: IDs, scores, timings only — never title/content
- Does **not** decide duplicates (that is Phase-3B.6)

## Phase-3B.6 — Semantic Advisory ONLY

- Flag: `AI_SEMANTIC_ENABLED` default **false**
- `semanticAdvisoryService.js` — embed → vector search → filtered advisory object
- Thresholds (cosine): possible ≥ **0.88**, strong ≥ **0.92** (env-configurable)
- Same `language` + `embeddingVersion` only
- Fail-open: errors → `{ enabled: true, available: false }`
- **Not** wired into newsController / gateway return / Reporter APIs
- Never overrides Exact/Near; never writes `duplicateCheck`

## Phase-4.1 — Embedding pipeline automation

- Flag: `AI_EMBED_WORKER_ENABLED` default **false**
- `embedPendingWorker.js` — poll PENDING → `/v1/embed` → READY | retry | FAILED
- Exponential backoff; max attempts configurable
- Respects `contentHash` (skip unchanged / refresh on mismatch)
- Writes **NewsVector only** (never duplicateCheck / News business fields)
- Metrics: success, retry, failure, skipped, avg latency
- Started from `server.js` only when flag ON (otherwise no-op)

## Phase-4.2 — PENDING enqueue on create/update

- `scheduleNewsVectorPending.js` — fire-and-forget after News save
- Create → `ensurePending()` → PENDING
- Update + contentHash change → `markStaleAndPrepareReembed()` (STALE then PENDING)
- Update unchanged hash → no-op
- Never blocks publish; never calls `/v1/embed` on request path
- Does not change duplicateCheck / gateway / Reporter responses

## Phase-4.2.6 — Worker claim / lease

- `embedWorkerClaim.js` — atomic `findOneAndUpdate` claim on PENDING
- Fields: `processingAt`, `processingBy`, `leaseExpiresAt` (default lease 60s)
- Only claimed rows are embedded; expired leases are reclaimable (crash-safe)
- READY / FAILED / retry / ensurePending clear claim fields

## Phase-4.3 — Observability & operations

- Extended `embedWorkerMetrics.js` (claimed, READY/FAILED, retries, skips, reclaims, latencies)
- `newsVectorQueueMetrics.js` — PENDING/READY/FAILED/STALE counts + oldest PENDING age
- `embedPipelineHealth.js` — worker / queue / AI / error summary
- Docs: `OBSERVABILITY.md` · script: `scripts/embed-pipeline-health.js`

