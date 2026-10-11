'use strict';

const {
  fetchAiCandidates,
  MAX_DETECT_CANDIDATES,
  PENDING_LIMIT,
} = require('../services/aiDuplicate/fetchCandidates');

// A tiny chainable News.find() mock that records each query + the limit applied,
// and returns whatever the caller maps for that query.
function makeNews(resultsFor) {
  const calls = [];
  const News = {
    find(query) {
      const call = { query, limit: null };
      calls.push(call);
      const chain = {
        select() { return chain; },
        sort() { return chain; },
        limit(n) { call.limit = n; return chain; },
        lean() { return Promise.resolve(resultsFor(query) || []); },
      };
      return chain;
    },
  };
  return { News, calls };
}

const classify = (q) => (q.isActive === false ? 'pending' : q.location ? 'near' : 'recent');

describe('fetchAiCandidates — bounded candidate fetch', () => {
  test('every published query is capped AT THE DB (never pulls the whole window)', async () => {
    const { News, calls } = makeNews(() => []);
    await fetchAiCandidates('hi', null, { News, location: 'Hyderabad' });

    const by = (kind) => calls.find((c) => classify(c.query) === kind);
    expect(by('recent').limit).toBe(MAX_DETECT_CANDIDATES); // the old bug: this was unbounded
    expect(by('near').limit).toBe(MAX_DETECT_CANDIDATES);
    expect(by('pending').limit).toBe(PENDING_LIMIT);
  });

  test('a same-location duplicate is included and de-duped (counted once, local first)', async () => {
    const local = { _id: 'L1', title: 'Local dup', location: 'Hyderabad', isActive: true, publishedAt: new Date() };
    const far = { _id: 'F1', title: 'Far story', location: 'Delhi', isActive: true, publishedAt: new Date() };
    const { News } = makeNews((q) => {
      const kind = classify(q);
      if (kind === 'near') return [local];           // same-location query returns the local dup
      if (kind === 'recent') return [far, local];    // recent query ALSO contains the local dup
      return [];                                      // pending
    });

    const rows = await fetchAiCandidates('hi', null, { News, location: 'Hyderabad' });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('L1');                      // local duplicate kept
    expect(ids.filter((id) => id === 'L1')).toHaveLength(1); // de-duped, not twice
    expect(ids[0]).toBe('L1');                        // same-location prioritised first
  });

  test('with no location it still returns recent + pending', async () => {
    const { News, calls } = makeNews((q) =>
      classify(q) === 'recent' ? [{ _id: 'R1', title: 't', isActive: true, publishedAt: new Date() }] : []);
    const rows = await fetchAiCandidates('te', null, { News });
    expect(rows.map((r) => r.id)).toContain('R1');
    // No same-location query is issued when there is no location.
    expect(calls.some((c) => classify(c.query) === 'near')).toBe(false);
  });
});
