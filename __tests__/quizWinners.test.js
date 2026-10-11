'use strict';

/** P3 — winner selection: eligibility, random + admin modes, dedup, one-time;
 * the lottery draws only 6/6 scorers who have never won before. */

const store = { entries: [], week: null, winners: [], users: [] };

const chain = (rows) => ({ select() { return this; }, lean: async () => rows });

jest.mock('../models/QuizEntry', () => ({
  aggregate: jest.fn(async (pipeline) => {
    const match = pipeline[0].$match;
    // Install ids per user (collusion + past-winner device checks).
    if (match.deviceId) {
      const ids = match.userId && match.userId.$in;
      const byUser = {};
      store.entries
        .filter((e) => e.deviceId && (!match.weekId || e.weekId === match.weekId) && (!ids || ids.includes(e.userId)) && (!match.submittedAt || e.submittedAt))
        .forEach((e) => { (byUser[e.userId] = byUser[e.userId] || new Set()).add(e.deviceId); });
      return Object.entries(byUser).map(([k, v]) => ({ _id: k, deviceIds: [...v] }));
    }
    // Week stats: group submitted entries by user.
    const byUser = {};
    store.entries.filter((e) => e.submittedAt && e.weekId === match.weekId).forEach((e) => {
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
  find: jest.fn((q) => chain(store.winners.filter((w) =>
    (!q.weekId || !q.weekId.$nin || !q.weekId.$nin.includes(w.weekId)) && (!q.isTest || w.isTest !== true)))),
  countDocuments: jest.fn(async (q) => store.winners.filter((w) => w.weekId === q.weekId).length),
}));
jest.mock('../models/User', () => ({
  find: jest.fn((q) => chain(store.users.filter((u) => q.googleId.$in.includes(u.googleId)))),
}));
jest.mock('../utils/auditLogger', () => ({ logAudit: jest.fn() }));

const { logAudit } = require('../utils/auditLogger');
const { computeWeekStats, lotteryPool, cryptoPick, selectWinners } = require('../services/quizWinnerService');
const { phoneKey, nameKey, buildPastWinnerIndex, matchPastWinner } = require('../services/quizPastWinnerService');

const WEEK = '2026-08-24'; // past week (Mon–Sat over as of test 'now')
const OLD_WEEK = '2026-08-17';
const REALDATE = Date;
beforeAll(() => { global.Date = class extends REALDATE { constructor(...a) { super(...(a.length ? a : ['2026-09-01T06:00:00+05:30'])); } static now() { return new REALDATE('2026-09-01T06:00:00+05:30').getTime(); } }; });
afterAll(() => { global.Date = REALDATE; });

/**
 * nEligible users answer all 6; the first `perfect` of them get all 6 right,
 * the rest get 3 of 6. nPartial users answer only 3 days. Each user has a phone
 * (98765000NN), a name ("Player N") and an install id (dev-uN).
 */
function seed(nEligible, nPartial, { perfect = 0 } = {}) {
  store.entries = []; store.week = null; store.winners = []; store.users = [];
  const day = (i) => `2026-08-${24 + i}`;
  for (let u = 0; u < nEligible; u++) {
    for (let d = 0; d < 6; d++) {
      store.entries.push({ userId: 'u' + u, weekId: WEEK, dayKey: day(d), isCorrect: u < perfect ? true : (u + d) % 2 === 0, submittedAt: '2026-08-29T1' + d + ':00:00Z', deviceId: 'dev-u' + u });
    }
    store.users.push({ googleId: 'u' + u, displayName: 'Player ' + u, mobileNumber: '98765000' + String(u).padStart(2, '0') });
  }
  for (let u = 0; u < (nPartial || 0); u++) for (let d = 0; d < 3; d++) store.entries.push({ userId: 'p' + u, weekId: WEEK, dayKey: day(d), isCorrect: true, submittedAt: '2026-08-27T10:00:00Z' });
}

/** A winner of an earlier week. */
function pastWinner(row) {
  store.winners.push({ weekId: OLD_WEEK, rank: store.winners.length + 1, mode: 'admin_select', mobileNumber: '', ...row });
}

const actor = { id: 'admin1', username: 'Admin' };
const drawn = (r) => r.winners.map((w) => w.userId);

beforeEach(() => logAudit.mockClear());

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

test('random_lottery selects exactly 10 distinct 6/6 scorers + freezes ranks', async () => {
  seed(15, 0, { perfect: 15 });
  const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
  expect(r.ok).toBe(true);
  expect(r.winners.length).toBe(10);
  expect(new Set(drawn(r)).size).toBe(10);
  expect(r.winners.map((w) => w.rank)).toEqual([1,2,3,4,5,6,7,8,9,10]);
  expect(r.short).toBe(0);
  expect(store.week.status).toBe('winners_selected');
});

describe('the lottery draws only 6/6', () => {
  test('5/6, 4/6 … are never drawn, however many runs', async () => {
    for (let run = 0; run < 20; run++) {
      seed(30, 0, { perfect: 12 }); // u0..u11 got 6/6; u12..u29 got 3/6
      const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
      expect(r.ok).toBe(true);
      expect(r.pool).toBe(12);
      expect(drawn(r).every((id) => Number(id.slice(1)) < 12)).toBe(true);
      expect(r.winners.every((w) => w.score === 6)).toBe(true);
    }
  });

  test('fewer than 10 perfect scorers → all of them win, the rest is left for the manual page', async () => {
    seed(20, 0, { perfect: 4 });
    const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
    expect(r.ok).toBe(true);
    expect(drawn(r).sort()).toEqual(['u0', 'u1', 'u2', 'u3']);
    expect(r.short).toBe(6);
    expect(store.winners.filter((w) => w.weekId === WEEK)).toHaveLength(4);
  });

  test('no one scored 6/6 → refused, nothing written, week not locked', async () => {
    seed(20, 0, { perfect: 0 });
    const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No one scored 6\/6/);
    expect(store.winners).toHaveLength(0);
    expect(store.week.status).toBe('active');
  });
});

describe('past winners never win the lottery again', () => {
  test('same account', async () => {
    seed(11, 0, { perfect: 11 });
    pastWinner({ userId: 'u0', displayName: 'Player 0' });
    const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
    expect(r.pool).toBe(10);
    expect(r.excludedPastWinners).toBe(1);
    expect(drawn(r)).not.toContain('u0');
  });

  test('same mobile on a hand-typed ("manual") winner', async () => {
    seed(11, 0, { perfect: 11 });
    pastWinner({ userId: `manual_${OLD_WEEK}_1_ab12cd`, displayName: 'P One', mobileNumber: '+91 98765-00001' });
    const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
    expect(drawn(r)).not.toContain('u1');
    expect(r.winners).toHaveLength(10);
  });

  test('same mobile on a different account (winner row had no mobile — found via the profile)', async () => {
    seed(11, 0, { perfect: 11 });
    pastWinner({ userId: 'g-old', displayName: 'Someone' });
    store.users.push({ googleId: 'g-old', displayName: 'Someone', mobileNumber: '9876500002' });
    const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
    expect(drawn(r)).not.toContain('u2');
  });

  test('played this week on a phone a past winner used', async () => {
    seed(11, 0, { perfect: 11 });
    pastWinner({ userId: 'g-old2', displayName: 'Other' });
    store.entries.push({ userId: 'g-old2', weekId: OLD_WEEK, dayKey: '2026-08-17', isCorrect: true, submittedAt: '2026-08-17T10:00:00Z', deviceId: 'dev-u3' });
    const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
    expect(drawn(r)).not.toContain('u3');
  });

  test('the same NAME alone does not keep anyone out — it is a warning', async () => {
    seed(9, 0, { perfect: 9 }); // pool of 9 → everyone is drawn, so the warning must show
    pastWinner({ userId: 'g-other', displayName: 'player  4.', mobileNumber: '9000000000' });
    const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
    expect(drawn(r)).toContain('u4');
    expect(r.nameWarnings).toEqual([expect.objectContaining({ userId: 'u4', weekId: OLD_WEEK })]);
  });

  test('test-mode winners do not count', async () => {
    seed(10, 0, { perfect: 10 });
    pastWinner({ userId: 'u0', displayName: 'Player 0', isTest: true });
    pastWinner({ userId: 'u1', displayName: 'Player 1', weekId: '2024-01-01' });
    const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
    expect(r.pool).toBe(10);
    expect(drawn(r)).toEqual(expect.arrayContaining(['u0', 'u1']));
  });

  test('every 6/6 scorer has won before → refused with the reason', async () => {
    seed(3, 0, { perfect: 2 });
    pastWinner({ userId: 'u0' });
    pastWinner({ userId: 'u1' });
    const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/All 2 who scored 6\/6 have won before/);
  });

  test('the audit log keeps the proof: pool size and who was kept out, and why', async () => {
    seed(12, 0, { perfect: 12 });
    pastWinner({ userId: 'u0' });
    pastWinner({ userId: `manual_${OLD_WEEK}_2_zz`, mobileNumber: '9876500005' });
    await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
    const a = logAudit.mock.calls[0][0];
    expect(a.after.draw).toEqual({
      scoredPerfect: 12,
      pool: 10,
      excluded: expect.arrayContaining([
        { userId: 'u0', reason: 'account', weekId: OLD_WEEK },
        { userId: 'u5', reason: 'phone', weekId: OLD_WEEK },
      ]),
    });
    expect(a.description).toMatch(/pool 10 of 12 perfect scorers, 2 past winners kept out/);
  });

  test("this week's own winners are not \"past\" winners", async () => {
    seed(12, 0, { perfect: 12 });
    store.winners.push({ weekId: WEEK, rank: 1, userId: 'u0', displayName: 'Player 0' });
    const { pool, excluded } = await lotteryPool(WEEK, (await computeWeekStats(WEEK)).eligible);
    expect(excluded).toHaveLength(0);
    expect(pool).toHaveLength(12);
  });
});

describe('matching rules', () => {
  test('phoneKey: last 10 digits, junk ignored', () => {
    expect(phoneKey('+91 98765-43210')).toBe('9876543210');
    expect(phoneKey('09876543210')).toBe('9876543210');
    expect(phoneKey('12345')).toBe('');
    expect(phoneKey('-')).toBe('');
    expect(phoneKey(null)).toBe('');
  });

  test('nameKey: case, dots and spaces ignored; Telugu vowel signs kept', () => {
    expect(nameKey('  Ravi   KUMAR. ')).toBe(nameKey('ravi kumar'));
    expect(nameKey('రవి')).not.toBe(nameKey('రవ'));
    expect(nameKey('(unknown)')).toBe('');
  });

  test('the most recent win is the one reported', () => {
    const idx = buildPastWinnerIndex([
      { weekId: '2026-08-31', userId: 'a', displayName: 'A' },
      { weekId: '2026-09-14', userId: 'a', displayName: 'A' },
    ]);
    expect(matchPastWinner({ userId: 'a' }, idx).pastWin).toEqual({ reason: 'account', weekId: '2026-09-14', wonAs: 'A' });
  });

  test('a hand-typed id never matches by account', () => {
    const idx = buildPastWinnerIndex([{ weekId: '2026-09-14', userId: 'manual_x', displayName: 'X' }]);
    expect(matchPastWinner({ userId: 'manual_x' }, idx).pastWin).toBeNull();
  });
});

test('admin_select: exactly 10 eligible succeeds', async () => {
  seed(12, 0);
  const ids = Array.from({ length: 10 }, (_, i) => 'u' + i);
  const r = await selectWinners({ weekId: WEEK, mode: 'admin_select', adminUserIds: ids, actor });
  expect(r.ok).toBe(true);
  expect(r.winners.length).toBe(10);
});

test('admin_select is a human choice — a past winner is allowed (the page warns instead)', async () => {
  seed(12, 0, { perfect: 12 });
  pastWinner({ userId: 'u0' });
  const ids = Array.from({ length: 10 }, (_, i) => 'u' + i);
  const r = await selectWinners({ weekId: WEEK, mode: 'admin_select', adminUserIds: ids, actor });
  expect(r.ok).toBe(true);
  expect(r.pool).toBeUndefined();
});

test('admin_select rejects wrong count / duplicates / non-eligible', async () => {
  seed(12, 3);
  expect((await selectWinners({ weekId: WEEK, mode: 'admin_select', adminUserIds: ['u0','u1'], actor })).ok).toBe(false); // too few
  expect((await selectWinners({ weekId: WEEK, mode: 'admin_select', adminUserIds: Array(10).fill('u0'), actor })).ok).toBe(false); // dup
  const withPartial = ['p0','u1','u2','u3','u4','u5','u6','u7','u8','u9'];
  expect((await selectWinners({ weekId: WEEK, mode: 'admin_select', adminUserIds: withPartial, actor })).ok).toBe(false); // p0 not eligible
});

test('one-time: second selection is rejected (immutable)', async () => {
  seed(15, 0, { perfect: 15 });
  const r1 = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
  expect(r1.ok).toBe(true);
  const r2 = await selectWinners({ weekId: WEEK, mode: 'admin_select', adminUserIds: Array.from({ length: 10 }, (_, i) => 'u' + i), actor });
  expect(r2.ok).toBe(false);
  expect(r2.error).toMatch(/already been selected/);
});

test('rejects selection before the week is over', async () => {
  seed(15, 0, { perfect: 15 });
  global.Date = class extends REALDATE { constructor(...a) { super(...(a.length ? a : ['2026-08-27T06:00:00+05:30'])); } static now() { return new REALDATE('2026-08-27T06:00:00+05:30').getTime(); } }; // Thu of that week
  const r = await selectWinners({ weekId: WEEK, mode: 'random_lottery', actor });
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/not over/);
  global.Date = class extends REALDATE { constructor(...a) { super(...(a.length ? a : ['2026-09-01T06:00:00+05:30'])); } static now() { return new REALDATE('2026-09-01T06:00:00+05:30').getTime(); } };
});
