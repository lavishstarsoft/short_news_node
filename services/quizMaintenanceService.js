'use strict';

/**
 * Quiz lifecycle maintenance (P5). Idempotent, no new scheduler infra — call from
 * an admin action or any external cron/uptime ping. Reuses OneSignal for reminders.
 *
 *  - closeExpiredWeeks: mark active weeks whose Mon–Sat window has passed as
 *    'closed', and set lockedForEdit=true on every question used that week
 *    (enforces "can't edit a question used in a completed cycle").
 *  - sendDailyReminder: push the daily quiz nudge on Mon–Sat.
 */

const QuizWeek = require('../models/QuizWeek');
const QuizEntry = require('../models/QuizEntry');
const QuizQuestion = require('../models/QuizQuestion');
const { istDateKey } = require('../utils/indianDateTime');
const { dayInfo } = require('../utils/quizWeek');

async function closeExpiredWeeks(now = new Date()) {
  const todayKey = istDateKey(now);
  const active = await QuizWeek.find({ status: 'active' }).lean();
  let closed = 0, locked = 0;
  for (const w of active) {
    if (w.endDate < todayKey) { // Saturday (endDate) already passed
      await QuizWeek.updateOne({ weekId: w.weekId, status: 'active' }, { $set: { status: 'closed' } });
      const qIds = await QuizEntry.distinct('questionId', { weekId: w.weekId });
      if (qIds.length) {
        const r = await QuizQuestion.updateMany({ _id: { $in: qIds }, lockedForEdit: false }, { $set: { lockedForEdit: true } });
        locked += r.modifiedCount || 0;
      }
      closed++;
    }
  }
  return { closed, locked };
}

async function sendDailyReminder(now = new Date()) {
  const di = dayInfo(now);
  if (!di.isQuizDay) return { sent: false, reason: 'not a quiz day' };
  try {
    const one = require('./oneSignalService');
    await one.sendNotificationToAll("Today's Quiz is live! 🧠", "Answer today's question — weekly top players win ₹1,000.", { type: 'quiz' });
    return { sent: true };
  } catch (e) { return { sent: false, error: e.message }; }
}

module.exports = { closeExpiredWeeks, sendDailyReminder };
