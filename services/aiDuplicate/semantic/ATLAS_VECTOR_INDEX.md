# Atlas Vector Search — Phase-3B.4 (design / ops checklist)

**Do NOT auto-create this index from the app.** Apply manually in Atlas UI or IaC after review.

## Collection

`news_vectors`

## Index (suggested name)

`news_vectors_embedding_e5s_v1`

## Vector field

| Setting | Value |
|---------|--------|
| Path | `embedding` |
| Dimensions | **384** |
| Similarity | **cosine** |
| Type | `knnVector` / Vector Search |

## Required filter fields (must be filterable in index definition)

- `status` (string) — queries always use `READY`
- `language` (string)
- `embeddingVersion` (string) — never cross-version
- `publishedAt` (date) — time window (default last **72 hours**)

## Expected `$vectorSearch` shape (built by `vectorSearchService`)

```js
{
  $vectorSearch: {
    index: "news_vectors_embedding_e5s_v1",
    path: "embedding",
    queryVector: [/* 384 floats */],
    numCandidates: topK * 10,
    limit: topK,
    filter: {
      status: "READY",
      language: "te",
      embeddingVersion: "e5s-v1",
      publishedAt: { $gte: ISODate("...") }
    }
  }
}
```

## Service output (only)

```json
{
  "ok": true,
  "matches": [
    {
      "newsId": "...",
      "score": 0.87,
      "publishedAt": "...",
      "language": "te",
      "embeddingVersion": "e5s-v1"
    }
  ],
  "meta": { "windowHours": 72, "topK": 10, "similarity": "cosine", "...": "..." }
}
```

No duplicate classification. No Exact/Near merge. Not wired to gateway/controllers in 3B.4.
