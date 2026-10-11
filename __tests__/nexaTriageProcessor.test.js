'use strict';

/**
 * NEXA bounded triage processor — deterministic tests (no DB, no AI).
 * Proves: only NOT-YET-ANALYSED items are selected, batches are bounded, and
 * repeated calls drain the backlog beyond the first 10 (the reported bug).
 */

process.env.NEXA_ENABLED = 'true'; // make config.isActive() true for these tests
delete process.env.NEXA_KILL_SWITCH;

const {
  selectUnanalyzedItems,
  processOnce,
} = require('../nexa/workflows/triageProcessor');

function pending(n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ _id: 'news' + i, title: 't' + i, publishedAt: new Date(2026, 0, 1, 0, i) });
  return rows;
}
function fakeGetPending(rows) {
  return async ({ limit }) => ({ ok: true, result: rows.slice(0, limit) });
}
function fakeNexaTask(doneSet) {
  return {
    find(q) {
      const ids = (q.entityId && q.entityId.$in ? q.entityId.$in : []).map(String);
      const out = ids.filter((id) => doneSet.has(id)).map((id) => ({ entityId: id }));
      const qb = { select() { return qb; }, lean() { return Promise.resolve(out); } };
      return qb;
    },
  };
}

describe('NEXA triage processor', () => {
  test('selects only not-yet-analysed items, bounded by batchSize', async () => {
    const rows = pending(25);
    const done = new Set(['news0', 'news1', 'news2']); // first 3 already analysed
    const sel = await selectUnanalyzedItems(
      { batchSize: 15, scanCap: 500 },
      { getPending: fakeGetPending(rows), NexaTask: fakeNexaTask(done) }
    );
    expect(sel.items).toHaveLength(15);
    // none of the returned items are already-analysed
    expect(sel.items.some((i) => done.has(String(i._id)))).toBe(false);
    // first returned is the oldest UN-analysed (news3)
    expect(String(sel.items[0]._id)).toBe('news3');
    expect(sel.remainingKnown).toBe(22);
  });

  test('processOnce drains the backlog BEYOND the first 10 across repeated calls', async () => {
    const rows = pending(25);
    const done = new Set(); // nothing analysed yet
    const NexaTask = fakeNexaTask(done);
    // fake triage: "analyse" the given items by adding them to done
    const runTriage = async ({ items }) => {
      items.forEach((it) => done.add(String(it._id)));
      return { created: items.length, alreadyDone: 0 };
    };
    const deps = { getPending: fakeGetPending(rows), NexaTask, runTriage };

    const r1 = await processOnce({ batchSize: 15 }, deps);
    expect(r1.created).toBe(15);
    expect(done.size).toBe(15);

    const r2 = await processOnce({ batchSize: 15 }, deps);
    expect(r2.created).toBe(10); // remaining 10 (beyond the first batch) get analysed
    expect(done.size).toBe(25);

    const r3 = await processOnce({ batchSize: 15 }, deps);
    expect(r3.created).toBe(0); // idempotent — nothing left
    expect(r3.selected).toBe(0);
  });

  test('inert when NEXA is not active', async () => {
    process.env.NEXA_ENABLED = 'false';
    const r = await processOnce({ batchSize: 15 }, { getPending: fakeGetPending(pending(5)), NexaTask: fakeNexaTask(new Set()) });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('nexa_inactive');
    process.env.NEXA_ENABLED = 'true'; // restore
  });

  test('empty pending → no work, no throw', async () => {
    const r = await processOnce({ batchSize: 15 }, { getPending: fakeGetPending([]), NexaTask: fakeNexaTask(new Set()) });
    expect(r.selected).toBe(0);
    expect(r.created).toBe(0);
  });
});
