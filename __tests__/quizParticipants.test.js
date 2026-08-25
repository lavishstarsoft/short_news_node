'use strict';

/**
 * Phases 2–4 — participant drill-down: server pagination/search, Super-Admin-only
 * PII (mobile/email/location), State→District→Constituency with Not Assigned.
 */

const store = { entries: [], users: [] };

jest.mock('../models/QuizEntry', () => ({
  aggregate: jest.fn(async (pipe) => {
    const match = (pipe[0] && pipe[0].$match) || {};
    const rows = store.entries.filter((e) => e.weekId === match.weekId);
    const m = new Map();
    for (const e of rows) {
      const b = m.get(e.userId) || { _id: e.userId, answered: 0, correct: 0, dayKeys: [], firstAssignedAt: e.assignedAt, lastSubmittedAt: null };
      if (e.submittedAt != null) { b.answered++; if (e.isCorrect) b.correct++; if (!b.lastSubmittedAt || e.submittedAt > b.lastSubmittedAt) b.lastSubmittedAt = e.submittedAt; }
      if (!b.dayKeys.includes(e.dayKey)) b.dayKeys.push(e.dayKey);
      if (e.assignedAt < b.firstAssignedAt) b.firstAssignedAt = e.assignedAt;
      m.set(e.userId, b);
    }
    return [...m.values()];
  }),
}));
jest.mock('../models/QuizWinner', () => ({ countDocuments: jest.fn(async () => 0) }));
jest.mock('../models/QuizQuestion', () => ({}));
jest.mock('../models/User', () => ({
  find: jest.fn((q) => ({ select: () => ({ lean: async () => {
    if (q.$or) { // search
      const rx = q.$or[0].displayName;
      return store.users.filter((u) => [u.displayName, u.mobileNumber, u.email, u.googleId].some((v) => v && rx.test(v)));
    }
    const ids = new Set(q.googleId.$in);
    return store.users.filter((u) => ids.has(u.googleId));
  } }) })),
}));
jest.mock('../utils/auditLogger', () => ({ logAudit: jest.fn() }));
jest.mock('../services/quizWinnerService', () => ({ computeWeekStats: jest.fn(), selectWinners: jest.fn() }));
jest.mock('../services/quizMaintenanceService', () => ({ closeExpiredWeeks: jest.fn(), sendDailyReminder: jest.fn() }));

const ctrl = require('../controllers/quizAdminController');
const WEEK = '2026-08-24';
function res() { return { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
function ent(userId, dayIndex, submitted, correct) {
  const day = String(23 + dayIndex).padStart(2, '0');
  return { userId, weekId: WEEK, dayKey: `2026-08-${day}`, dayIndex, assignedAt: new Date(2026, 7, 23 + dayIndex, 6), submittedAt: submitted ? new Date(2026, 7, 23 + dayIndex, 7) : null, isCorrect: submitted ? !!correct : null };
}

beforeEach(() => {
  store.entries = []; store.users = [];
  for (let d = 1; d <= 6; d++) store.entries.push(ent('g1', d, true, d <= 4)); // 6 answered, 4 correct → complete
  for (let d = 1; d <= 3; d++) store.entries.push(ent('g2', d, true, d <= 1)); // 3 answered, 1 correct
  store.users.push(
    { googleId: 'g1', displayName: 'Asha', mobileNumber: '9998887771', email: 'asha@x.com', locationProfile: { primaryState: 'Telangana', primaryDistrict: 'Hyderabad' }, deviceFingerprint: 'dev1' },
    { googleId: 'g2', displayName: 'Bilal', mobileNumber: '9998887772', email: 'bilal@x.com', locationProfile: {} },
  );
});

const superReq = (query) => ({ admin: { role: 'superadmin' }, query: { weekId: WEEK, ...query } });
const adminReq = (query) => ({ admin: { role: 'admin' }, query: { weekId: WEEK, ...query } });

test('super admin sees PII + State→District→Constituency (Not Assigned when missing)', async () => {
  const r = res(); await ctrl.listParticipants(superReq({}), r);
  expect(r.body.pii).toBe(true);
  expect(r.body.total).toBe(2);
  const asha = r.body.participants.find((p) => p.userId === 'g1');
  expect(asha).toMatchObject({ name: 'Asha', mobile: '9998887771', email: 'asha@x.com', score: 4, answered: 6, correct: 4, wrong: 2, completed: true, completion: '6/6' });
  expect(asha.location).toEqual({ state: 'Telangana', district: 'Hyderabad', constituency: 'Not Assigned' });
  const bilal = r.body.participants.find((p) => p.userId === 'g2');
  expect(bilal.location).toEqual({ state: 'Not Assigned', district: 'Not Assigned', constituency: 'Not Assigned' });
  expect(bilal).toMatchObject({ answered: 3, correct: 1, wrong: 2, completed: false });
});

test('non-super admin gets NO mobile/email/location', async () => {
  const r = res(); await ctrl.listParticipants(adminReq({}), r);
  expect(r.body.pii).toBe(false);
  const p = r.body.participants[0];
  expect(p.name).toBeDefined();
  expect(p.mobile).toBeUndefined();
  expect(p.email).toBeUndefined();
  expect(p.location).toBeUndefined();
});

test('server-side pagination (pageSize clamped to a sane floor of 5)', async () => {
  for (let n = 3; n <= 8; n++) store.entries.push(ent('g' + n, 1, true, true)); // → 8 participants total
  const r1 = res(); await ctrl.listParticipants(superReq({ page: 1, pageSize: 5 }), r1);
  expect(r1.body.pageSize).toBe(5);
  expect(r1.body.total).toBe(8);
  expect(r1.body.pages).toBe(2);
  expect(r1.body.participants).toHaveLength(5);
  const r2 = res(); await ctrl.listParticipants(superReq({ page: 2, pageSize: 5 }), r2);
  expect(r2.body.participants).toHaveLength(3);
});

test('search filters by name/mobile/email', async () => {
  const r = res(); await ctrl.listParticipants(superReq({ q: 'Bilal' }), r);
  expect(r.body.total).toBe(1);
  expect(r.body.participants[0].userId).toBe('g2');
});

test('dayKey filter restricts to that day\'s participants', async () => {
  // Day 5 (2026-08-28): only g1 has an entry.
  const r = res(); await ctrl.listParticipants(superReq({ dayKey: '2026-08-28' }), r);
  expect(r.body.total).toBe(1);
  expect(r.body.participants[0].userId).toBe('g1');
});
