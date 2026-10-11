'use strict';

/** Winners (Manual) page: past winners are tagged and reported — never blocked. */

const store = { winners: [], users: [], entries: [] };
const chain = (rows) => ({ select() { return this; }, sort() { return this; }, lean: async () => rows });

jest.mock('../models/QuizWinner', () => ({
  find: jest.fn((q) => chain(store.winners.filter((w) =>
    (typeof q.weekId === 'string' ? w.weekId === q.weekId : !q.weekId.$nin.includes(w.weekId)) && (!q.isTest || w.isTest !== true)))),
  countDocuments: jest.fn(async (q) => store.winners.filter((w) => w.weekId === q.weekId).length),
  deleteMany: jest.fn(async (q) => { store.winners = store.winners.filter((w) => w.weekId !== q.weekId); return {}; }),
  insertMany: jest.fn(async (docs) => { store.winners.push(...docs); return docs; }),
}));
jest.mock('../models/QuizWeek', () => ({ updateOne: jest.fn(async () => ({})) }));
jest.mock('../models/QuizEntry', () => ({
  aggregate: jest.fn(async (pipeline) => {
    const match = pipeline[0].$match;
    const ids = match.userId && match.userId.$in;
    const byUser = {};
    store.entries
      .filter((e) => (!match.weekId || e.weekId === match.weekId) && (!ids || ids.includes(e.userId)))
      .forEach((e) => { (byUser[e.userId] = byUser[e.userId] || new Set()).add(e.deviceId); });
    return Object.entries(byUser).map(([k, v]) => ({ _id: k, deviceIds: [...v] }));
  }),
}));
jest.mock('../models/User', () => ({
  find: jest.fn((q) => chain(store.users.filter((u) => q.googleId.$in.includes(u.googleId)))),
}));
jest.mock('../services/quizWinnerService', () => ({
  computeWeekStats: jest.fn(async () => ({
    participants: [],
    eligible: [
      { userId: 'a', answered: 6, correct: 6 },
      { userId: 'b', answered: 6, correct: 6 },
      { userId: 'c', answered: 6, correct: 5 },
    ],
  })),
}));
jest.mock('../utils/auditLogger', () => ({ logAudit: jest.fn() }));

const ctrl = require('../controllers/quizManualWinnersController');

const WEEK = '2026-09-21';
const OLD = '2026-09-14';

function res() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

beforeEach(() => {
  store.users = [
    { googleId: 'a', displayName: 'Anil', mobileNumber: '9000000001' },
    { googleId: 'b', displayName: 'Bhavani', mobileNumber: '9000000002' },
    { googleId: 'c', displayName: 'Chandra', mobileNumber: '9000000003' },
  ];
  store.entries = [];
  store.winners = [
    { weekId: OLD, rank: 1, userId: 'a', displayName: 'Anil', mobileNumber: '' },                            // same account
    { weekId: OLD, rank: 2, userId: `manual_${OLD}_2_x`, displayName: 'Typed Person', mobileNumber: '9000000009' },
    { weekId: OLD, rank: 3, userId: 'zz', displayName: 'Chandra', mobileNumber: '9111111111' },             // name only
    { weekId: '2024-01-01', rank: 1, userId: 'b', displayName: 'Bhavani', isTest: true },                   // test — ignored
  ];
});

test('eligible members carry 6/6, won-before and same-name tags', async () => {
  const r = res();
  await ctrl.getData({ query: { weekId: WEEK } }, r);
  const by = Object.fromEntries(r.body.eligible.map((e) => [e.userId, e]));
  expect(by.a).toMatchObject({ perfect: true, pastWin: { reason: 'account', weekId: OLD } });
  expect(by.b).toMatchObject({ perfect: true, pastWin: null, nameMatch: null });
  expect(by.c).toMatchObject({ perfect: false, pastWin: null, nameMatch: { weekId: OLD } });
});

test('saving past winners is allowed, and each one is reported with the reason', async () => {
  const r = res();
  await ctrl.save({
    query: {},
    body: {
      weekId: WEEK,
      winners: [
        { userId: 'a', name: 'Anil', mobile: '9000000001' },
        { userId: 'b', name: 'Bhavani', mobile: '9000000002' },
        { name: 'Someone New', mobile: '+91 90000 00009' }, // typed — same phone as a past manual winner
        { name: 'chandra', mobile: '' },                     // typed — name only
      ],
    },
    admin: { name: 'Admin' },
  }, r);
  expect(r.body.ok).toBe(true);
  expect(r.body.count).toBe(4);
  expect(r.body.repeats).toEqual([
    { rank: 1, name: 'Anil', reason: 'account', weekId: OLD },
    { rank: 3, name: 'Someone New', reason: 'phone', weekId: OLD },
    { rank: 4, name: 'chandra', reason: 'name', weekId: OLD },
  ]);
  expect(store.winners.filter((w) => w.weekId === WEEK)).toHaveLength(4);
});
