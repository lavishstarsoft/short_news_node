'use strict';

/**
 * Quiz Test Mode — admin day simulation. Verifies that an active per-user override
 * simulates Mon..Sun of the isolated 2024 test week (weekId 2024-01-01), that real
 * users are completely unaffected, that Sunday shows the winners block, that
 * "Create Test Winners" writes isolated isTest winners, and that exiting test mode
 * immediately restores real IST behaviour. All models are mocked.
 */

const store = { questions: [], entries: [], winners: [], overrides: [], users: [] };

jest.mock('../models/QuizQuestion', () => ({
  aggregate: jest.fn(async (pipe) => {
    const match = (pipe[0] && pipe[0].$match) || {};
    let pool = store.questions.filter((q) => (match.isActive === undefined || q.isActive === match.isActive));
    if (match._id && match._id.$nin) { const nin = new Set(match._id.$nin.map(String)); pool = pool.filter((q) => !nin.has(String(q._id))); }
    return pool.length ? [pool[0]] : [];
  }),
  findById: jest.fn((id) => ({ lean: async () => store.questions.find((q) => String(q._id) === String(id)) || null })),
  find: jest.fn(() => ({ lean: async () => store.questions })),
  updateOne: jest.fn(async () => ({})),
  countDocuments: jest.fn(async () => 100), // healthy pool → no alert
}));
jest.mock('../models/QuizEntry', () => ({
  findOne: jest.fn(async (q) => store.entries.find((e) => e.userId === q.userId && e.weekId === q.weekId && e.dayKey === q.dayKey) || null),
  find: jest.fn((q) => {
    const rows = q && q.$or
      ? store.entries.filter((e) => q.$or.some((c) => (c.userId !== undefined && e.userId === c.userId) || (c.deviceId !== undefined && e.deviceId != null && e.deviceId === c.deviceId)))
      : store.entries.filter((e) => e.userId === q.userId && (q.weekId === undefined || e.weekId === q.weekId));
    return { select: () => ({ lean: async () => rows }), lean: async () => rows };
  }),
  updateOne: jest.fn(async (filter, update) => {
    if (update.$setOnInsert) {
      const exists = store.entries.find((e) => e.userId === filter.userId && e.weekId === filter.weekId && e.dayKey === filter.dayKey);
      if (!exists) { store.entries.push({ _id: 'e' + (store.entries.length + 1), ...update.$setOnInsert, selectedOption: null, isCorrect: null, submittedAt: null }); return { upsertedCount: 1 }; }
    }
    return { matchedCount: 1 };
  }),
}));
jest.mock('../models/QuizWeek', () => ({ updateOne: jest.fn(async () => ({})) }));
jest.mock('../models/QuizWinner', () => ({
  find: jest.fn((q) => ({ sort: () => ({ lean: async () => store.winners.filter((w) => w.weekId === q.weekId).sort((a, b) => a.rank - b.rank) }) })),
  deleteMany: jest.fn(async (q) => { const before = store.winners.length; store.winners = store.winners.filter((w) => !(w.weekId === q.weekId && (q.isTest === undefined || w.isTest === q.isTest))); return { deletedCount: before - store.winners.length }; }),
  insertMany: jest.fn(async (docs) => { store.winners.push(...docs); return docs; }),
}));
jest.mock('../models/QuizTestOverride', () => ({
  findOne: jest.fn((q) => {
    const match = store.overrides.find((o) => o.userId === q.userId && (q.active === undefined || o.active === q.active)) || null;
    return { lean: async () => match };
  }),
  find: jest.fn((q) => ({ sort: () => ({ lean: async () => store.overrides
    .filter((o) => q.active === undefined || o.active === q.active)
    .slice().sort((a, b) => (b._ts || 0) - (a._ts || 0)) }) })),
  updateOne: jest.fn(async (filter, update) => {
    let o = store.overrides.find((x) => x.userId === filter.userId);
    if (!o) { o = { userId: filter.userId }; store.overrides.push(o); }
    Object.assign(o, update.$set); o._ts = Date.now() + Math.random(); return { upsertedCount: 1 };
  }),
}));
jest.mock('../models/User', () => ({
  // Random-sample mock: honours { mobileNumber: { $nin: [null,''] } } and { _id: { $nin } }.
  aggregate: jest.fn(async (pipe) => {
    const match = (pipe.find((s) => s.$match) || {}).$match || {};
    const sample = (pipe.find((s) => s.$sample) || {}).$sample || { size: store.users.length };
    let pool = store.users.slice();
    if (match.mobileNumber && Array.isArray(match.mobileNumber.$nin)) pool = pool.filter((u) => u.mobileNumber != null && u.mobileNumber !== '');
    if (match._id && Array.isArray(match._id.$nin)) { const nin = new Set(match._id.$nin.map(String)); pool = pool.filter((u) => !nin.has(String(u._id))); }
    return pool.slice(0, sample.size);
  }),
  find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
  findOne: jest.fn((q) => ({ select: () => ({ lean: async () => {
    if (q.googleId !== undefined && !q.$or) return store.users.find((u) => u.googleId === q.googleId) || null;
    const or = q.$or || [];
    return store.users.find((u) => or.some((c) => (
      (c.googleId !== undefined && u.googleId === c.googleId) ||
      (c.email !== undefined && u.email === c.email) ||
      (c.mobileNumber !== undefined && u.mobileNumber === c.mobileNumber) ||
      (c.displayName !== undefined && u.displayName === c.displayName) ||
      (c._id !== undefined && String(u._id) === String(c._id))
    ))) || null;
  } }) })),
}));
jest.mock('../utils/auditLogger', () => ({ logAudit: jest.fn() }));
jest.mock('../services/quizWinnerService', () => ({ computeWeekStats: jest.fn(), selectWinners: jest.fn() }));
jest.mock('../services/quizMaintenanceService', () => ({ closeExpiredWeeks: jest.fn(), sendDailyReminder: jest.fn() }));
jest.mock('../services/quizLanguageService', () => ({
  isQuizLanguageAllowed: jest.fn(async () => true),
  getQuizConfig: jest.fn(async () => ({ isEnabled: true, enabledLanguages: ['te'] }))
}));

const ctrl = require('../controllers/quizController');
const admin = require('../controllers/quizAdminController');
const { TEST_WEEK_MONDAY } = require('../utils/quizWeek');

function res() { return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
const REALDATE = Date;
function mockNow(iso) { global.Date = class extends REALDATE { constructor(...a) { super(...(a.length ? a : [iso])); } static now() { return new REALDATE(iso).getTime(); } }; }
afterEach(() => { global.Date = REALDATE; });

beforeEach(() => {
  store.questions = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ _id: 'q' + n, isActive: true, options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }], correctOption: 'A', text: 'Q' + n }));
  store.entries = []; store.winners = []; store.overrides = []; store.users = [];
});

function setOverride(userId, simDayIndex, active = true) { store.overrides.push({ userId, simDayIndex, active }); }

// Real "now" is deep in production (2026); test mode must ignore it entirely.
const PROD_NOW = '2026-08-24T06:00:00+05:30'; // a real Monday

describe('simulated weekdays (Mon..Sat)', () => {
  [1, 2, 3, 4, 5, 6].forEach((day) => {
    test(`day ${day} → quiz day in the isolated 2024 test week`, async () => {
      mockNow(PROD_NOW);
      setOverride('test-user', day);
      const r = res(); await ctrl.today({ verifiedGoogleId: 'test-user', body: {}, query: { lang: 'te' } }, r);
      expect(r.body.testMode).toBe(true);
      expect(r.body.isQuizDay).toBe(true);
      expect(r.body.dayIndex).toBe(day);
      expect(r.body.weekId).toBe(TEST_WEEK_MONDAY); // 2024, never a real week
      expect(r.body.question).toBeTruthy();
    });
  });
});

test('simulated Sunday (day 7) → winners block, testMode true, "announced soon" until winners exist', async () => {
  mockNow(PROD_NOW);
  setOverride('test-user', 7);
  const r = res(); await ctrl.today({ verifiedGoogleId: 'test-user', body: {}, query: { lang: 'te' } }, r);
  expect(r.body.testMode).toBe(true);
  expect(r.body.isSunday).toBe(true);
  expect(r.body.isQuizDay).toBe(false);
  expect(r.body.weekId).toBe(TEST_WEEK_MONDAY);
  expect(r.body.winnersReady).toBe(false); // no winners yet → app shows "announced soon"
});

test('Create Test Winners → 10 REAL-user isTest winners, then simulated Sunday shows them', async () => {
  // 12 real users: 6 with a mobile number, 6 without → mobile users are preferred.
  store.users = Array.from({ length: 12 }, (_, i) => ({
    _id: 'u' + i, googleId: 'g' + i, displayName: 'User ' + i,
    mobileNumber: i < 6 ? '90000000' + i : '', photoUrl: i < 6 ? 'http://img/' + i + '.png' : '',
  }));
  const ar = res(); await admin.createTestWinners({ admin: { name: 'Tester' }, body: {} }, ar);
  expect(ar.body.ok).toBe(true);
  expect(ar.body.count).toBe(10);
  expect(store.winners).toHaveLength(10);
  expect(store.winners.every((w) => w.isTest === true && w.weekId === TEST_WEEK_MONDAY)).toBe(true);
  // Real data was copied onto the winner docs (no "Test Winner N" dummy names).
  expect(store.winners.every((w) => /^User \d+$/.test(w.displayName))).toBe(true);
  expect(store.winners.some((w) => w.mobileNumber && w.mobileNumber.length)).toBe(true);
  // Mobile-number users are prioritised → all 6 of them are included.
  expect(store.winners.filter((w) => w.mobileNumber).length).toBe(6);

  mockNow(PROD_NOW);
  setOverride('test-user', 7);
  const r = res(); await ctrl.today({ verifiedGoogleId: 'test-user', body: {}, query: { lang: 'te' } }, r);
  expect(r.body.winnersReady).toBe(true);
  expect(r.body.winners).toHaveLength(10);
  expect(r.body.winners[0].rank).toBe(1);
});

test('real user (no override) is unaffected → real IST week, testMode false', async () => {
  mockNow(PROD_NOW); // real Monday 2026-08-24
  const r = res(); await ctrl.today({ verifiedGoogleId: 'real-user', body: {}, query: { lang: 'te' } }, r);
  expect(r.body.testMode).toBe(false);
  expect(r.body.weekId).toBe('2026-08-24'); // real production week, not the 2024 test week
  expect(r.body.dayIndex).toBe(1);
});

test('exiting test mode (active:false) immediately restores real IST behaviour', async () => {
  mockNow(PROD_NOW);
  setOverride('test-user', 6, false); // disabled override
  const r = res(); await ctrl.today({ verifiedGoogleId: 'test-user', body: {}, query: { lang: 'te' } }, r);
  expect(r.body.testMode).toBe(false);
  expect(r.body.weekId).toBe('2026-08-24'); // back to real week, ignores simDayIndex
});

test('setTestMode upserts an active override keyed by googleId; getTestMode reflects it', async () => {
  store.users.push({ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', googleId: 'g-9', displayName: 'Nine', mobileNumber: '9', email: 'n@x.com' });
  const sr = res(); await admin.setTestMode({ admin: { name: 'Tester' }, body: { q: 'g-9', simDayIndex: 3, active: true } }, sr);
  expect(sr.body.ok).toBe(true);
  expect(sr.body.dayLabel).toBe('Wednesday');
  expect(store.overrides[0].userId).toBe('g-9'); // keyed by googleId, not the query
  const gr = res(); await admin.getTestMode({ query: { q: 'g-9' } }, gr);
  expect(gr.body.resolved).toBe(true);
  expect(gr.body.active).toBe(true);
  expect(gr.body.simDayIndex).toBe(3);
});

describe('identifier → verifiedGoogleId resolution (the reported bug)', () => {
  const OID = '69b24c19c0a5fb3988094a46'; // real Mongo _id from the bug report
  const GID = '111481529715342708687';    // the user's actual googleId
  beforeEach(() => {
    store.users.push({ _id: OID, googleId: GID, displayName: 'Ashok Kumar', mobileNumber: '9876500000', email: 'ashokca810@gmail.com' });
  });

  test('resolveUserByAny maps a Mongo _id to the correct googleId', async () => {
    const u = await admin._internals.resolveUserByAny(OID);
    expect(u).toBeTruthy();
    expect(u.googleId).toBe(GID);
    expect(u.displayName).toBe('Ashok Kumar');
  });

  ['69b24c19c0a5fb3988094a46', '9876500000', 'ashokca810@gmail.com', 'Ashok Kumar', '111481529715342708687']
    .forEach((ident) => {
      test(`resolve-user endpoint finds the user by "${ident}" and returns the googleId`, async () => {
        const r = res(); await admin.resolveTestUser({ query: { q: ident } }, r);
        expect(r.code).toBe(200);
        expect(r.body.user.googleId).toBe(GID);
        expect(r.body.user.name).toBe('Ashok Kumar');
      });
    });

  test('enabling test mode via _id keys the override by googleId (NOT the _id) → sim actually applies', async () => {
    const sr = res(); await admin.setTestMode({ admin: { name: 'Tester' }, body: { q: OID, simDayIndex: 1, active: true } }, sr);
    expect(sr.body.ok).toBe(true);
    expect(sr.body.user.googleId).toBe(GID);
    expect(store.overrides.find((o) => o.userId === GID)).toBeTruthy();
    expect(store.overrides.find((o) => o.userId === OID)).toBeFalsy(); // never keyed by _id

    // And the quiz APIs, keyed on verifiedGoogleId, now see the simulation.
    mockNow(PROD_NOW);
    const tr = res(); await ctrl.today({ verifiedGoogleId: GID, body: {}, query: { lang: 'te' } }, tr);
    expect(tr.body.testMode).toBe(true);
    expect(tr.body.weekId).toBe(TEST_WEEK_MONDAY);
    expect(tr.body.dayIndex).toBe(1);
  });

  test('unknown identifier → 404 clear error, no override written', async () => {
    const r = res(); await admin.setTestMode({ admin: { name: 'T' }, body: { q: 'no-such-user', simDayIndex: 2, active: true } }, r);
    expect(r.code).toBe(404);
    expect(r.body.error).toMatch(/No user matches/);
    expect(store.overrides).toHaveLength(0);
  });

  test('resolve-user for a missing id → 404 with a clear message', async () => {
    const r = res(); await admin.resolveTestUser({ query: { q: 'ffffffffffffffffffffffff' } }, r);
    expect(r.code).toBe(404);
    expect(r.body.error).toMatch(/No user matches/);
  });

  // Persistence: MongoDB is the source of truth; the dashboard restores state on
  // refresh via activeTestMode (no identifier needed).
  test('Enable → reload shows saved state → change day → reload persists → Disable → reload empty', async () => {
    // default empty state before anything is enabled
    let a = res(); await admin.activeTestMode({ query: {} }, a);
    expect(a.body.active).toHaveLength(0);

    // Enable by _id, day 4
    await admin.setTestMode({ admin: { name: 'T' }, body: { q: OID, simDayIndex: 4, active: true } }, res());

    // Reload → active override restored, keyed by googleId, day 4, user visible
    a = res(); await admin.activeTestMode({ query: {} }, a);
    expect(a.body.active).toHaveLength(1);
    expect(a.body.active[0].googleId).toBe(GID);
    expect(a.body.active[0].simDayIndex).toBe(4);
    expect(a.body.active[0].dayLabel).toBe('Thursday');
    expect(a.body.active[0].user.name).toBe('Ashok Kumar');

    // Change day → 7, reload persists the new day
    await admin.setTestMode({ admin: { name: 'T' }, body: { q: GID, simDayIndex: 7, active: true } }, res());
    a = res(); await admin.activeTestMode({ query: {} }, a);
    expect(a.body.active).toHaveLength(1);
    expect(a.body.active[0].simDayIndex).toBe(7);
    expect(a.body.active[0].dayLabel).toBe('Sunday');

    // Disable → reload shows the empty/disabled state (no active override)
    await admin.setTestMode({ admin: { name: 'T' }, body: { q: OID, simDayIndex: 7, active: false } }, res());
    a = res(); await admin.activeTestMode({ query: {} }, a);
    expect(a.body.active).toHaveLength(0);
  });
});

test('createTestWinners force-includes a specific googleId as rank 1 (real name + mobile), no dupes', async () => {
  const PIN = '116084063595442894365';
  store.users = [
    { _id: 'pinned', googleId: PIN, displayName: 'Pinned Star', mobileNumber: '8801188886', photoUrl: 'http://img/pin.png' },
    ...Array.from({ length: 11 }, (_, i) => ({ _id: 'u' + i, googleId: 'g' + i, displayName: 'User ' + i, mobileNumber: i < 5 ? '900000' + i : '', photoUrl: '' })),
  ];
  const r = res(); await admin.createTestWinners({ admin: { name: 'T' }, body: { pinnedGoogleId: PIN } }, r);
  expect(r.body.count).toBe(10);
  const rank1 = store.winners.find((w) => w.rank === 1);
  expect(rank1.userId).toBe('pinned');
  expect(rank1.displayName).toBe('Pinned Star');
  expect(rank1.mobileNumber).toBe('8801188886');
  expect(rank1.profileImage).toBe('http://img/pin.png');
  expect(store.winners.filter((w) => w.userId === 'pinned')).toHaveLength(1); // not duplicated
});

test('createTestWinners is idempotent and clearTestWinners removes only test winners', async () => {
  store.users = Array.from({ length: 12 }, (_, i) => ({ _id: 'u' + i, googleId: 'g' + i, displayName: 'User ' + i, mobileNumber: '90000000' + i, photoUrl: '' }));
  await admin.createTestWinners({ admin: { name: 'T' }, body: {} }, res());
  await admin.createTestWinners({ admin: { name: 'T' }, body: {} }, res()); // re-run
  expect(store.winners).toHaveLength(10); // replaced, not duplicated
  const cr = res(); await admin.clearTestWinners({ body: {} }, cr);
  expect(cr.body.deleted).toBe(10);
  expect(store.winners).toHaveLength(0);
});
