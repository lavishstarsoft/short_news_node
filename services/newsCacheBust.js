'use strict';

/**
 * Bust EVERY cache that could still serve a news item after its public status
 * changed (rejected / deactivated / sent back for revision / deleted).
 *
 * Why: the feed caches (GraphQL Redis lists, REST cacheMiddleware) are keyed by
 * query, not by item. A story that was LIVE, got cached, and was then rejected
 * would otherwise keep appearing until the TTL ran out (60s–600s). The rule is
 * strict: the moment a story stops being public it must vanish everywhere —
 * including from caches. Call this right after the status write succeeds.
 *
 * Never throws — a cache hiccup must not undo or block the moderation action.
 */
const { invalidateCache, invalidateItemCache } = require('../graphql/cache');
const { clearCache } = require('../middleware/cache');

async function bustNewsCaches(newsId, reason = 'status-change') {
  const id = newsId ? String(newsId) : '';
  const jobs = [
    invalidateCache('graphql:news:*'),                 // GraphQL feed lists (all variants)
    id ? invalidateItemCache('newsById', id) : null,   // GraphQL single item
    clearCache('cache:/api/public/news*'),              // REST feed + /news/location/* + /news/:id*
    clearCache('cache:/api/public/locations*'),         // location counts that embed news
  ].filter(Boolean);
  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed) console.warn(`[newsCacheBust] ${failed}/${jobs.length} cache clears failed (${reason}, news ${id})`);
}

module.exports = { bustNewsCaches };
