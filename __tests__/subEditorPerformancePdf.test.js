'use strict';

const { computeScores, buildPerformancePdf, gradeOf, SCORE } = require('../services/reports/subEditorPerformancePdf');
const { resolvePeriod } = require('../services/reports/subEditorWorkReport');

function row(over) {
  return { authorId: over.authorId || 'x', name: over.name || 'N', isActive: true, posted: 0, video: 0, published: 0, pendingNow: 0, aiFlagged: 0, publishedAnyway: 0, rejected: 0, sentBack: 0, edited: 0, deleted: 0, views: 0, byLanguage: {}, hours: new Array(24).fill(0), avgPublishMinutes: null, ...over };
}

describe('performance score', () => {
  test('perfect self-publisher at/above target scores 100 (A+)', () => {
    const rows = computeScores([row({ posted: 40 }), row({ posted: 10 }), row({ posted: 0 })]);
    expect(rows[0].scoreTarget).toBe(40); // p75 of [10,40] → 40
    expect(rows[0].score).toBe(100);
    expect(rows[0].grade).toBe('A+');
    expect(rows[2].score).toBe(0);
    expect(rows[2].grade).toBe('—');
  });
  test('target floor is 20 when the team is small', () => {
    const rows = computeScores([row({ posted: 5 })]);
    expect(rows[0].scoreTarget).toBe(SCORE.TARGET_MIN);
    expect(rows[0].scoreParts.volume).toBe(Math.round((5 / 20) * SCORE.VOLUME));
  });
  test('duplicates, rejects, slowness and deletes reduce the score', () => {
    const [r] = computeScores([row({ posted: 20, aiFlagged: 5, rejected: 2, sentBack: 2, avgPublishMinutes: 67.5, deleted: 4 })]);
    expect(r.scoreParts.volume).toBe(30);
    expect(r.scoreParts.quality).toBe(Math.round(35 * 0.5)); // 25% dup → half
    expect(r.scoreParts.discipline).toBe(Math.round(20 * 0.6)); // 20% issues
    expect(r.scoreParts.speed).toBe(Math.round(15 * 0.5)); // 67.5 min → half
    expect(r.scoreParts.penalty).toBe(15); // capped
    expect(r.score).toBe(52); // round(30 + 17.5 + 12 + 7.5 - 15)
    expect(r.grade).toBe(gradeOf(r.score));
  });
  test('grades', () => {
    expect(gradeOf(95)).toBe('A+'); expect(gradeOf(80)).toBe('A'); expect(gradeOf(79)).toBe('B'); expect(gradeOf(60)).toBe('C'); expect(gradeOf(59)).toBe('D');
  });
});

describe('performance pdf', () => {
  test('renders selected rows only, with grand total and insights', async () => {
    const period = resolvePeriod({ date: '2026-09-11' });
    const rows = computeScores([
      row({ authorId: 'a', name: 'K.L.V. ASHOK KUMAR', posted: 38, published: 38, byLanguage: { hi: 25, te: 13 }, hours: new Array(24).fill(0).map((_, i) => (i >= 9 && i <= 15 ? 5 : 0)), aiFlagged: 3, views: 300 }),
      row({ authorId: 'b', name: 'Dheeraj', posted: 49, published: 49, byLanguage: { hi: 10, te: 39 }, video: 2, deleted: 1 }),
      row({ authorId: 'c', name: 'Hidden', posted: 99 }),
    ]);
    const { doc, reportId, selected } = buildPerformancePdf({ rows, totals: {}, period, selectedIds: ['a', 'b'], generatedBy: 'test', logoPath: '/nonexistent.png' });
    expect(selected).toBe(2);
    expect(reportId).toMatch(/^SEWR-/);
    const chunks = []; doc.on('data', (c) => chunks.push(c)); const done = new Promise((r) => doc.on('end', r)); doc.end(); await done;
    const buf = Buffer.concat(chunks);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });
  test('empty selection period renders a no-activity insight without throwing', async () => {
    const period = resolvePeriod({ date: '2026-09-11' });
    const rows = computeScores([row({ authorId: 'a', name: 'Idle' })]);
    const { doc } = buildPerformancePdf({ rows, totals: {}, period, selectedIds: ['a'] });
    doc.on('data', () => {}); const done = new Promise((r) => doc.on('end', r)); doc.end(); await done;
  });
});
