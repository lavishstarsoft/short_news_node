'use strict';

/**
 * How long a pending news item has been waiting, and what that means.
 *
 * The SAME numbers live in the app (`lib/utils/waiting.dart`). They are here as
 * well because the app decides when to ring and the server decides when to tell
 * the admin — if the two ever disagree, an In-Charge gets an alarm for
 * something the desk does not consider late, or worse, the desk reports someone
 * whose phone never rang. A test asserts both lists match.
 */

const SOON_MINUTES = 15;
const ALARM_MINUTES = 30;      // the app starts its loud alarm
const ESCALATE_MINUTES = 40;   // the admin is told
const SECOND_ESCALATE_MINUTES = 60; // and again, higher up

const minutesWaiting = (postedAt, now = new Date()) => {
  const t = new Date(postedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 60000));
};

/** fresh | soon | alarm | escalate | escalate2 */
function levelFor(minutes) {
  if (minutes >= SECOND_ESCALATE_MINUTES) return 'escalate2';
  if (minutes >= ESCALATE_MINUTES) return 'escalate';
  if (minutes >= ALARM_MINUTES) return 'alarm';
  if (minutes >= SOON_MINUTES) return 'soon';
  return 'fresh';
}

const shouldAlarm = (minutes) => minutes >= ALARM_MINUTES;
const shouldTellAdmin = (minutes) => minutes >= ESCALATE_MINUTES;

module.exports = {
  SOON_MINUTES,
  ALARM_MINUTES,
  ESCALATE_MINUTES,
  SECOND_ESCALATE_MINUTES,
  minutesWaiting,
  levelFor,
  shouldAlarm,
  shouldTellAdmin,
};
