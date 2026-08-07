# Smart View Distribution Engine (isolated plug-in)

Adaptive, AI-ready engine that distributes **synthetic** view counts to eligible news
items over a campaign window — without ever contaminating organic analytics.

## Isolation contract (locked)

| Value | Field | Written by | Read by |
|-------|-------|-----------|---------|
| Organic (canonical) | `News.views` | existing organic flow only | analytics, fraud, recommendations, ML — **always** |
| Synthetic | `News.syntheticViews` | this engine only (`$inc`) | `displayViews.js` only |
| Display (derived) | `views + syntheticViews` | computed, never stored | consumer app only |

- Single ON/OFF switch: `AppSettings.viewEngineEnabled` (default **false**).
- **OFF ⇒ behaves exactly as today.** Env kill switch: `VIEW_ENGINE_KILL=true`.
- Combined display is assembled in exactly one place: `displayViews.js`. No endpoint
  duplicates `views + syntheticViews`.
- PM2 cluster safe via Redis leader election (`leader.js`).

## Files

| File | Status | Purpose |
|------|--------|---------|
| `index.js` | Phase 2 | Entry point `maybeStartViewEngine(io)`; flag→engine supervisor |
| `config.js` | Phase 2 | Cached ON/OFF flag reader (sync for hot paths) |
| `displayViews.js` | Phase 2 | Centralized combined-display helper |
| `leader.js` | Phase 2 | Redis leader election (cluster safety) |
| `constants.js` | Phase 2 | Namespaced Redis keys, timings, log prefix |
| `models/ViewCampaign.js` | Phase 2 | Campaign config + safeguards |
| `models/ViewDistributionState.js` | Phase 2 | Live per-item adaptive state |
| `models/ViewCycleLog.js` | Phase 2 | Idempotency ledger + rollback + audit/training |
| `ticker.js` | **stub** | Leader-only scheduler (Phase 3) |
| `signalProvider / strategy / allocator / curve / planner / worker / applier` | Phase 3 | Adaptive distribution logic |

## Production safeguards (schema in place, enforced in Phase 3)

1. **Global budget protection** — `ViewCampaign.budgetProtection.maxItemSharePct` +
   per-item `ViewDistributionState.cap`.
2. **Cooldown** — `ViewCampaign.cooldown.restCycles` + state `cooldownUntilCycle`.
3. **Diversity allocation** — `ViewCampaign.diversity` (category / region / publisher
   buckets) + state `bucket`.

## Rollout

Flag OFF-first: deploy → indexes build on empty collections → dry-run campaign →
live pilot → rollout. Rollback: flag OFF (instant) or `reverseCampaign` (ledger →
negative `$inc` on `syntheticViews`; `views` never touched).
