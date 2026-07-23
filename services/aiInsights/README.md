# AI Insights — Duplicate News Insights

Super Admin editorial intelligence for **live published** news.

## Architecture

- **Node** owns grouping, Mongo writes, APIs, UI
- **Python** provides embeddings earlier via `/v1/embed` (existing worker) — not called on page load
- **Mongo** stores `ai_duplicate_groups`, `ai_duplicate_scan_runs`, `ai_duplicate_daily_metrics`
- Reuses `News`, `news_vectors`, `Admin`

## Flags (default OFF)

```bash
AI_INSIGHTS_ENABLED=false
AI_INSIGHTS_SCAN_ENABLED=false
# AI_INSIGHTS_MIN_SIMILARITY=0.88
# AI_INSIGHTS_COMPARE_WINDOW_HOURS=72
# AI_INSIGHTS_MAX_PER_LANGUAGE=20000
# AI_INSIGHTS_SCAN_POLL_MS=900000
# AI_INSIGHTS_FULL_SCAN_COOLDOWN_MS=3600000
```

## URLs

- Page: `/admin/ai-insights/duplicate-news`
- Detail: `/admin/ai-insights/duplicate-news/groups/:id`
- Manual scan: `POST /admin/api/ai-insights/scan`

## Safety

- Super Admin only (sidebar + routes)
- No auto reject / unpublish / punish
- Advisory copy only
- Page load reads precomputed groups only
