'use strict';

/**
 * IST week/day helpers for the Daily Quiz. A quiz week runs Monday→Saturday (IST);
 * Sunday shows that week's winners. weekId is the Monday's IST date key (YYYY-MM-DD),
 * so historical weeks are stable and derivable from any timestamp.
 */

const { istDateKey } = require('./indianDateTime');

function keyToUTC(k) { const [y, m, d] = String(k).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }
/** IST date key n calendar days after key k (weekday is timezone-independent for a calendar date). */
function addDaysKey(k, n) { const dt = keyToUTC(k); dt.setUTCDate(dt.getUTCDate() + n); return istDateKey(dt); }

/** { weekId, dayKey, dayIndex(Mon=1..Sat=6, Sun=0), isQuizDay } for the IST day of `date`. */
function dayInfo(date = new Date()) {
  const dayKey = istDateKey(date);
  const dow = keyToUTC(dayKey).getUTCDay();       // 0=Sun..6=Sat
  const dayIndex = dow === 0 ? 0 : dow;           // Mon=1..Sat=6, Sun=0
  const mondayOffset = dow === 0 ? -6 : (1 - dow);
  const weekId = addDaysKey(dayKey, mondayOffset);
  return { weekId, dayKey, dayIndex, dow, isQuizDay: dayIndex >= 1 && dayIndex <= 6 };
}

/** The 6 IST day keys (Mon..Sat) of a week. */
function weekDayKeys(weekId) { return [0, 1, 2, 3, 4, 5].map((i) => addDaysKey(weekId, i)); }

function weekMeta(weekId) {
  return { weekId, startDate: weekId, endDate: addDaysKey(weekId, 5), sundayDate: addDaysKey(weekId, 6) };
}

/** Has the Mon–Sat window for weekId fully passed (i.e. it is Sunday-or-later in IST)? */
function isWeekOver(weekId, now = new Date()) {
  return istDateKey(now) > weekMeta(weekId).endDate;
}

// ── Test mode (admin day simulation) ──
// A fixed reference Monday used ONLY for admin test simulation. It lives far from
// production (2024), so test QuizEntry/QuizWinner records (weekId = this) can never
// collide with real weeks (2026+) and cannot affect live users.
const TEST_WEEK_MONDAY = '2024-01-01'; // a real Monday
/** Real calendar date for a simulated day: 1=Mon..6=Sat, 7=Sun (of the test week). */
function simTestDate(dayIndex) {
  const n = Math.max(1, Math.min(7, parseInt(dayIndex, 10) || 1));
  return addDaysKey(TEST_WEEK_MONDAY, n === 7 ? 6 : n - 1);
}

module.exports = { addDaysKey, dayInfo, weekDayKeys, weekMeta, isWeekOver, simTestDate, TEST_WEEK_MONDAY, QUIZ_DAYS: 6, WINNER_COUNT: 10 };
