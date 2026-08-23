'use strict';

/** P3 — winner selection: eligibility, random + admin modes, dedup, one-time. */

const store = { entries: [], week: null, winners: [] };

jest.mock('../models/QuizEntry', () => ({
  aggregate: jest.fn(async () => {
    // group submitted entries by user
    const byUser = {};
    store.entries.filter((e) => e.submittedAt).forEach((e) => {
      const u = (byUser[e.userId] = byUser[e.userId] || { _id: e.userId, answered: 0, correct: 0, lastSubmittedAt: e.submittedAt });
      u.answered++; if (e.isCorrect) u.correct++;
      if (new Date(e.submittedAt) > new Date(u.lastSubmittedAt)) u.lastSubmittedAt = e.submittedAt;
    });
    return Object.values(byUser);
  }),
}));
jest.mock('../models/QuizWeek', () => ({
  updateOne: jest.fn(async (filter, update) => {
    if (update.$setOnInsert) { if (!store.week) store.week = { weekId: filter.weekId, status: 'active' }; return { upsertedCount: 1 }; }
    // atomic status flip
    if (store.week && filter.status && filter.status.$in && filter.status.$in.includes(store.week.status)) {
      store.week.status = update.$set.status; return { modifiedCount: 1 };
    }
    return { modifiedCount: 0 };
  }),
}));
jest.mock('../models/QuizWinner', () => ({
  insertMany: jest.fn(async (docs) => {
    for (const d of docs) {
      if (store.winners.some((w) => w.weekId === d.weekId && (w.rank === d.rank || w.userId === d.userId))) { const e = new Error('dup'); e.code = 11000; throw e; }
      store.winners.push(d);
    }
    return docs;
  }),
  countDocuments: jest.fn(async (q) => store.winners.filter((w) => w.weekId === q.weekId).length),
}));
jest.mock('../utils/auditLogger', () => ({ logAudit: jest.fn() }));

const { computeWeekStats, cryptoPick, selectWinners } = require('../services/quizWinnerService');

const WEEK = '2026-08-24'; // past week (Mon–Sat over as of test 'now')
const REALDATE = Date;
beforeAll(() => { global.Date = class extends REALDATE { constructor(...a) { super(...(a.length ? a : ['2026-09-01T06:00:00+05:30'])); } static now() { return new REALDATE('2026-09-01T06:00:00+05:30').getTime(); } }; });
afterAll(() => { global.Date = REALDATE; });

function seed(nEligible, nPartial) {
  store.entries = []; store.week = null; store.winners = [];
  const day = (i) => `2026-08-${24 + i}`;
  for (let u = 0; u < nEligible; u++) for (let d = 0; d < 6; d++) store.entries.push({ userId: 'u' + u, weekId: WEEK, dayKey: day(d), isCorrect: (u + d) % 2 === 0, submittedAt: '2026-08-29T1' + d + ':00:00Z' });
  for (let u = 0; u < (nPartial || 0); u++) for (let d = 0; d < 3; d++) store.entries.push({ userId: 'p' + u, weekId: WEEK, dayKey: day(d), isCorrect: true, submittedAt: '2026-08-27T10:00:00Z' });
}

const actor = { id: 'admin1', username: 'Admin' };

test('eligibility = answered all 6; partial users excluded', async () => {
  seed(12, 5);
  const { eligible, participants } = await computeWeekStats(WEEK);
  expect(participants.length).toBe(17);
  expect(eligible.length).toBe(12);
  expect(eligible.every((e) => e.answered === 6)).toBe(true);
});

test('cryptoPick returns n distinct items', () => {
  const arr = Array.from({ length: 20 }, (_, i) => ({ userId: 'x' + i }));
  const p = cryptoPick(arr, 10);
  expect(p.length).toBe(10);
  expect(new Set(p.map((x) => x.userId)).size).toBe(10);
});

test('random_lottery selects exactly 10 distinct eligible + freezes ranks', async () => {
  seed(15, 0);
  const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
  expect(r.ok).toBe(true);
  expect(r.winners.length).toBe(10);
  expect(new Set(r.winners.map((w) => w.userId)).size).toBe(10);
  expect(r.winners.map((w) => w.rank)).toEqual([1,2,3,4,5,6,7,8,9,10]);
  expect(store.week.status).toBe('winners_selected');
});

test('random_lottery rejected when <10 eligible', async () => {
  seed(7, 0);
  const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/at least 10/);
});

test('admin_select: exactly 10 eligible succeeds', async () => {
  seed(12, 0);
  const ids = Array.from({ length: 10 }, (_, i) => 'u' + i);
  const r = await selectWinners({ weekId: WEEK, mode: 'admin_select', adminUserIds: ids, actor });
  expect(r.ok).toBe(true);
  expect(r.winners.length).toBe(10);
});

test('admin_select rejects wrong count / duplicates / non-eligible', async () => {
  seed(12, 3);
  expect((await selectWinners({ weekId: WEEK, mode: 'admin_select', adminUserIds: ['u0','u1'], actor })).ok).toBe(false); // too few
  expect((await selectWinners({ weekId: WEEK, mode: 'admin_select', adminUserIds: Array(10).fill('u0'), actor })).ok).toBe(false); // dup
  const withPartial = ['p0','u1','u2','u3','u4','u5','u6','u7','u8','u9'];
  expect((await selectWinners({ weekId: WEEK, mode: 'admin_select', adminUserIds: withPartial, actor })).ok).toBe(false); // p0 not eligible
});

test('one-time: second selection is rejected (immutable)', async () => {
  seed(15, 0);
  const r1 = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
  expect(r1.ok).toBe(true);
  const r2 = await selectWinners({ weekId: WEEK, mode: 'admin_select', adminUserIds: Array.from({ length: 10 }, (_, i) => 'u' + i), actor });
  expect(r2.ok).toBe(false);
  expect(r2.error).toMatch(/already been selected/);
});

test('rejects selection before the week is over', async () => {
  seed(15, 0);
  global.Date = class extends REALDATE { constructor(...a) { super(...(a.length ? a : ['2026-08-27T06:00:00+05:30'])); } static now() { return new REALDATE('2026-08-27T06:00:00+05:30').getTime(); } }; // Thu of that week
  const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/not over/);
  global.Date = class extends REALDATE { constructor(...a) { super(...(a.length ? a : ['2026-09-01T06:00:00+05:30'])); } static now() { return new REALDATE('2026-09-01T06:00:00+05:30').getTime(); } };
});
