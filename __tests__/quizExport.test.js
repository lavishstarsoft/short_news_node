'use strict';

/**
 * Phase 8 — CSV export. Participant/winner CSV with Super-Admin PII gating,
 * formula-injection escaping, and no test winners in the winner report.
 */

const store = { entries: [], users: [], winners: [] };

jest.mock('../models/QuizEntry', () => ({
  aggregate: jest.fn(async (pipe) => {
    const rows = store.entries.filter((e) => e.weekId === (pipe[0].$match.weekId));
    const m = new Map();
    for (const e of rows) {
      const b = m.get(e.userId) || { _id: e.userId, answered: 0, correct: 0, dayKeys: [], firstAssignedAt: e.assignedAt, lastSubmittedAt: null };
      if (e.submittedAt != null) { b.answered++; if (e.isCorrect) b.correct++; b.lastSubmittedAt = e.submittedAt; }
      if (!b.dayKeys.includes(e.dayKey)) b.dayKeys.push(e.dayKey);
      m.set(e.userId, b);
    }
    return [...m.values()];
  }),
}));
jest.mock('../models/QuizWinner', () => ({
  find: jest.fn((q) => ({ sort: () => ({ lean: async () => store.winners.filter((w) => (q.weekId === undefined || w.weekId === q.weekId) && (q.isTest === undefined || (q.isTest.$ne !== undefined ? w.isTest !== q.isTest.$ne : true))) }) })),
}));
jest.mock('../models/QuizQuestion', () => ({}));
jest.mock('../models/QuizTestOverride', () => ({}));
jest.mock('../models/User', () => ({
  find: jest.fn((q) => ({ select: () => ({ lean: async () => { const ids = new Set(q.googleId.$in); return store.users.filter((u) => ids.has(u.googleId)); } }) })),
}));
jest.mock('../utils/auditLogger', () => ({ logAudit: jest.fn() }));
jest.mock('../services/quizWinnerService', () => ({ computeWeekStats: jest.fn(), selectWinners: jest.fn() }));
jest.mock('../services/quizMaintenanceService', () => ({ closeExpiredWeeks: jest.fn(), sendDailyReminder: jest.fn() }));
jest.mock('../services/quizAnalyticsService', () => {
  const real = jest.requireActual('../services/quizAnalyticsService');
  return { weekAnalytics: jest.fn(), participantStats: real.participantStats };
});

const ctrl = require('../controllers/quizAdminController');
const WEEK = '2026-08-24';
function res() { return { code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; }, send(b) { this.body = b; return this; } }; }
function ent(userId, dayIndex, submitted, correct) {
  const day = String(23 + dayIndex).padStart(2, '0');
  return { userId, weekId: WEEK, dayKey: `2026-08-${day}`, dayIndex, assignedAt: new Date(Date.UTC(2026, 7, 23 + dayIndex, 1)), submittedAt: submitted ? new Date(Date.UTC(2026, 7, 23 + dayIndex, 2)) : null, isCorrect: submitted ? !!correct : null };
}

beforeEach(() => {
  store.entries = []; store.users = []; store.winners = [];
  for (let d = 1; d <= 6; d++) store.entries.push(ent('g1', d, true, d <= 4));
  store.users.push({ googleId: 'g1', displayName: '=SUM(A1)', mobileNumber: '9990001111', email: 'a@x.com', locationProfile: { primaryState: 'Telangana' } });
});

const superReq = (query) => ({ admin: { role: 'superadmin' }, query: { weekId: WEEK, ...query } });
const adminReq = (query) => ({ admin: { role: 'admin' }, query: { weekId: WEEK, ...query } });

test('participants CSV: super admin gets PII cols + formula-injection escaped + Not Assigned', async () => {
  const r = res(); await ctrl.exportParticipants(superReq({}), r);
  expect(r.headers['Content-Type']).toMatch(/text\/csv/);
  expect(r.headers['Content-Disposition']).toContain('quiz_participants_' + WEEK);
  const lines = r.body.split('\r\n');
  expect(lines[0]).toBe('UserId,Name,Mobile,Email,State,District,Constituency,Score,Answered,Correct,Wrong,Completed,FirstAssignedAt,LastSubmittedAt');
  expect(lines[1]).toContain("'=SUM(A1)"); // formula guarded with leading quote
  expect(lines[1]).toContain('9990001111');
  expect(lines[1]).toContain('Not Assigned'); // district + constituency
  expect(lines[1]).toContain('4,6,4,2,Yes'); // score,answered,correct,wrong,completed
});

test('participants CSV: non-super admin has NO PII columns', async () => {
  const r = res(); await ctrl.exportParticipants(adminReq({}), r);
  const header = r.body.split('\r\n')[0];
  expect(header).toBe('UserId,Name,Score,Answered,Correct,Wrong,Completed');
  expect(r.body).not.toContain('9990001111');
});

test('winners CSV excludes test winners; PII gated', async () => {
  store.winners.push(
    { weekId: WEEK, rank: 1, userId: 'g1', displayName: 'Asha', score: 5, answered: 6, mode: 'admin_select', isTest: false, selectedByName: 'root', selectedAt: new Date() },
    { weekId: WEEK, rank: 2, userId: 'gt', displayName: 'Test Winner', score: 4, answered: 6, mode: 'admin_select', isTest: true, selectedByName: 'root', selectedAt: new Date() },
  );
  const r = res(); await ctrl.exportWinners(superReq({}), r);
  const lines = r.body.split('\r\n');
  expect(lines[0]).toContain('Mobile');
  expect(r.body).toContain('Asha');
  expect(r.body).not.toContain('Test Winner'); // isTest excluded
  expect(r.body).toContain('9990001111'); // super sees mobile
});
