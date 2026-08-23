'use strict';

/** P1 — IST quiz-week helpers + question validation (pure). */
const { dayInfo, weekDayKeys, weekMeta, isWeekOver } = require('../utils/quizWeek');
const { validateQuestion } = require('../controllers/quizAdminController');

describe('quizWeek IST helpers', () => {
  test('Monday → weekId=itself, dayIndex 1, quiz day', () => {
    const d = dayInfo(new Date('2026-08-24T06:00:00+05:30')); // Mon 24 Aug 2026 IST
    expect(d.weekId).toBe('2026-08-24');
    expect(d.dayIndex).toBe(1);
    expect(d.isQuizDay).toBe(true);
  });
  test('Saturday → same weekId, dayIndex 6, quiz day', () => {
    const d = dayInfo(new Date('2026-08-29T06:00:00+05:30')); // Sat
    expect(d.weekId).toBe('2026-08-24');
    expect(d.dayIndex).toBe(6);
    expect(d.isQuizDay).toBe(true);
  });
  test('Sunday → belongs to just-ended week, dayIndex 0, NOT a quiz day', () => {
    const d = dayInfo(new Date('2026-08-30T06:00:00+05:30')); // Sun
    expect(d.weekId).toBe('2026-08-24');
    expect(d.dayIndex).toBe(0);
    expect(d.isQuizDay).toBe(false);
  });
  test('weekDayKeys = Mon..Sat (6 days)', () => {
    expect(weekDayKeys('2026-08-24')).toEqual(['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29']);
  });
  test('weekMeta start/end/sunday', () => {
    expect(weekMeta('2026-08-24')).toEqual({ weekId: '2026-08-24', startDate: '2026-08-24', endDate: '2026-08-29', sundayDate: '2026-08-30' });
  });
  test('isWeekOver true on/after Sunday', () => {
    expect(isWeekOver('2026-08-24', new Date('2026-08-29T23:00:00+05:30'))).toBe(false); // Sat
    expect(isWeekOver('2026-08-24', new Date('2026-08-30T06:00:00+05:30'))).toBe(true);  // Sun
  });
});

describe('validateQuestion', () => {
  const good = { text: 'Capital of India?', options: [{ key: 'A', text: 'Delhi' }, { key: 'B', text: 'Mumbai' }], correctOption: 'A' };
  test('accepts a valid MCQ', () => { expect(validateQuestion(good).ok).toBe(true); });
  test('rejects <2 options', () => { expect(validateQuestion({ ...good, options: [{ key: 'A', text: 'Delhi' }] }).ok).toBe(false); });
  test('rejects correctOption not among options', () => { expect(validateQuestion({ ...good, correctOption: 'C' }).ok).toBe(false); });
  test('rejects duplicate keys', () => { expect(validateQuestion({ ...good, options: [{ key: 'A', text: 'x' }, { key: 'A', text: 'y' }] }).ok).toBe(false); });
  test('rejects invalid key', () => { expect(validateQuestion({ ...good, options: [{ key: 'E', text: 'x' }, { key: 'B', text: 'y' }], correctOption: 'B' }).ok).toBe(false); });
  test('rejects empty text', () => { expect(validateQuestion({ ...good, text: '' }).ok).toBe(false); });
});
