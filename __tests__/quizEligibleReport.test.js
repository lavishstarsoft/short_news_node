'use strict';

/** Quiz "Eligible users" PDF: the data behind it, and that it renders. */

const mockStore = { participants: [], winners: [], drawLog: null, screen: new Map(), pastIndex: null };
const mockChain = (v) => ({ sort() { return this; }, select() { return this; }, lean: async () => v });

jest.mock('../models/QuizWinner', () => ({ find: jest.fn(() => mockChain(mockStore.winners)) }));
jest.mock('../models/AuditLog', () => ({ findOne: jest.fn(() => mockChain(mockStore.drawLog)) }));
jest.mock('../services/quizWinnerService', () => ({
  computeWeekStats: jest.fn(async () => ({
    participants: mockStore.participants,
    eligible: mockStore.participants.filter((p) => p.answered >= 6)
      .sort((a, b) => (b.correct - a.correct) || (new Date(a.lastSubmittedAt) - new Date(b.lastSubmittedAt))),
  })),
  lotteryPool: jest.fn(async (weekId, eligible, screen) => {
    const perfect = eligible.filter((e) => e.correct >= 6);
    return {
      perfect: perfect.length,
      pool: perfect.filter((e) => !(screen.get(e.userId) || {}).pastWin),
      excluded: perfect.filter((e) => (screen.get(e.userId) || {}).pastWin),
    };
  }),
}));
jest.mock('../services/quizPastWinnerService', () => ({
  screenPastWinners: jest.fn(async (weekId, ids) => new Map(ids.map((id) => [id, mockStore.screen.get(id) || { name: 'Name ' + id, pastWin: null, nameMatch: null }]))),
  loadPastWinnerIndex: jest.fn(async () => mockStore.pastIndex),
  matchPastWinner: jest.fn((person) => ({ pastWin: person.mobile === '9000000009' ? { reason: 'phone', weekId: '2026-09-07', wonAs: 'Old' } : null, nameMatch: null })),
}));

const { eligibleReportData, renderEligiblePdf, pickedByLabel, statusOf } = require('../services/reports/quizEligibleReport');

const WEEK = '2026-09-21';
const player = (id, correct, answered = 6, min = 0) => ({ userId: id, correct, answered, lastSubmittedAt: new Date(Date.UTC(2026, 8, 26, 5, min)) });

function seed() {
  mockStore.participants = [
    ...Array.from({ length: 12 }, (_, i) => player('u' + i, 6, 6, i)),
    player('five', 5), player('four', 4), player('partial', 3, 3),
  ];
  mockStore.winners = Array.from({ length: 10 }, (_, i) => ({ weekId: WEEK, rank: i + 1, userId: 'u' + i, displayName: 'Winner ' + i, score: 6 }));
  mockStore.screen = new Map([['u11', { name: 'Old Winner', pastWin: { reason: 'account', weekId: '2026-09-14', wonAs: 'Old Winner' }, nameMatch: null }]]);
  // The draw picked u0..u8 and u10; u9 was put in by hand afterwards.
  mockStore.drawLog = { after: { mode: 'random_lottery', winners: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10].map((i) => ({ userId: 'u' + i })) } };
  mockStore.pastIndex = { any: true };
}

beforeEach(seed);

test('all winners 6/6 and new → a clean verdict; totals match the dashboard', async () => {
  const d = await eligibleReportData(WEEK);
  expect(d.totals).toEqual({ answeredAll: 14, scoredPerfect: 12, wonBefore: 1, inLottery: 11, winners: 10 });
  expect(d.verdict).toMatchObject({ selected: true, allPerfect: true, noneWonBefore: true, notPerfect: [], wonBefore: [] });
});

test('how each winner got on the list: lottery, or changed on the manual page', async () => {
  const d = await eligibleReportData(WEEK);
  const by = Object.fromEntries(d.winners.map((w) => [w.rank, w.pickedBy]));
  expect(by[1]).toBe('Lottery');
  expect(by[10]).toBe('Manual page'); // u9 was not in the draw
  expect(pickedByLabel('manual_2026-09-21_3_ab', mockStore.drawLog)).toBe('Typed by hand');
  expect(pickedByLabel('u1', { mode: 'admin_select', ids: new Set(['u1']) })).toBe('Admin select');
});

test('the score comes from the actual answers, not the saved winner score', async () => {
  mockStore.winners[2] = { ...mockStore.winners[2], userId: 'five', displayName: 'Five', score: 6 }; // saved "6" — really 5/6
  const d = await eligibleReportData(WEEK);
  const w = d.winners.find((x) => x.rank === 3);
  expect(w).toMatchObject({ correct: 5, answered: 6, perfect: false });
  expect(d.verdict.allPerfect).toBe(false);
  expect(d.verdict.notPerfect).toEqual(['#3 Five']);
});

test('a hand-typed winner: not a quiz player, and a past winner found by phone', async () => {
  mockStore.winners[9] = { weekId: WEEK, rank: 10, userId: 'manual_x', displayName: 'Typed', mobileNumber: '9000000009' };
  const d = await eligibleReportData(WEEK);
  const w = d.winners.find((x) => x.rank === 10);
  expect(w).toMatchObject({ played: false, perfect: false, pickedBy: 'Typed by hand', pastWin: { reason: 'phone' } });
  expect(d.verdict.wonBefore).toEqual(['#10 Typed']);
});

test('no winners yet → says so', async () => {
  mockStore.winners = [];
  const d = await eligibleReportData(WEEK);
  expect(d.verdict.selected).toBe(false);
});

test('status per row: winner, won before, not 6/6, in draw', async () => {
  const d = await eligibleReportData(WEEK);
  const by = Object.fromEntries(d.rows.map((r) => [r.name, statusOf(r).text]));
  expect(by['Name u0']).toBe('WINNER #1');
  expect(by['Old Winner']).toBe('Won before');
  expect(by['Name five']).toBe('Not 6/6');
  expect(by['Name u10']).toBe('In draw');
  expect(d.rows.map((r) => r.name)).not.toContain('Name partial'); // answered 3 — not eligible
});

function pdfBuffer(data) {
  return new Promise((resolve, reject) => {
    const doc = renderEligiblePdf(data, { now: new Date('2026-09-27T05:00:00Z') });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}
const pages = (buf) => (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;

test('renders a real PDF — long lists run onto more pages, Telugu names included', async () => {
  mockStore.participants = Array.from({ length: 150 }, (_, i) => player('u' + i, i < 90 ? 6 : 5, 6, i % 60));
  mockStore.screen.set('u3', { name: 'రవి కుమార్', pastWin: null, nameMatch: null });
  const buf = await pdfBuffer(await eligibleReportData(WEEK));
  expect(buf.slice(0, 4).toString()).toBe('%PDF');
  expect(pages(buf)).toBeGreaterThanOrEqual(4);
});

test('a short list is exactly one page (the footer does not spill onto a blank page)', async () => {
  mockStore.participants = [player('u0', 6)];
  mockStore.winners = [];
  const buf = await pdfBuffer(await eligibleReportData(WEEK));
  expect(pages(buf)).toBe(1);
});

test('completion time is short enough for its column (IST, no year)', () => {
  const { shortIst } = require('../services/reports/quizEligibleReport');
  expect(shortIst('2026-09-25T23:33:00Z')).toMatch(/^26 Sept?, 05:03 AM$/);
  expect(shortIst('2026-09-26T08:05:00Z')).toMatch(/^26 Sept?, 01:35 PM$/);
});

test('noon and midnight read 12, never 00', () => {
  const { shortIst } = require('../services/reports/quizEligibleReport');
  expect(shortIst('2026-09-26T06:46:00Z')).toMatch(/, 12:16 PM$/); // 12:16 PM IST
  expect(shortIst('2026-09-25T18:40:00Z')).toMatch(/, 12:10 AM$/); // 12:10 AM IST
});
