'use strict';

/**
 * "Has this person won before?" — so the weekly lottery never picks a past winner
 * again, and admins see it when they pick winners by hand.
 *
 * A past winner is recognised three ways; any one keeps them out of the lottery:
 *   • account — same googleId
 *   • phone   — same 10-digit mobile (the winner row's snapshot, or the winner's
 *               profile). The only way to recognise hand-typed ("manual_") winners.
 *   • device  — this week's play came from an app install a past winner used
 * A matching NAME alone is only a warning: two different "Ravi Kumar"s are common.
 *
 * Test winners (isTest, or the isolated 2024 test week) never count.
 */

const QuizWinner = require('../models/QuizWinner');
const QuizEntry = require('../models/QuizEntry');
const User = require('../models/User');
const { TEST_WEEK_MONDAY } = require('../utils/quizWeek');
const { deviceIdsByUser } = require('./quizCollusionService');

const isManualId = (id) => String(id || '').startsWith('manual_');

/** Last 10 digits of a phone number, or '' when it is not a real number. */
function phoneKey(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

/** A name folded for comparison: case, dots and extra spaces ignored. Keeps
 * combining marks (\p{M}) — Telugu/Hindi vowel signs are marks, not letters. */
function nameKey(v) {
  const k = String(v || '').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  return k === 'unknown' ? '' : k;
}

/**
 * Index the past winners. Pure: rows in, lookup maps out. When someone won more
 * than once, the most recent win is the one reported.
 * @param {Array} winners  QuizWinner rows { weekId, userId, displayName, mobileNumber }
 * @param {Array} profiles User rows of the real winners { googleId, mobileNumber }
 * @param {Map}   devices  userId → install ids that winner has ever played on
 */
function buildPastWinnerIndex(winners, profiles = [], devices = new Map()) {
  const profileMobile = new Map((profiles || []).map((p) => [p.googleId, phoneKey(p.mobileNumber)]));
  const byAccount = new Map(); const byPhone = new Map(); const byDevice = new Map(); const byName = new Map();
  const put = (map, key, info) => { if (key && !map.has(key)) map.set(key, info); };
  const latestFirst = [...(winners || [])].sort((a, b) => String(b.weekId).localeCompare(String(a.weekId)));
  for (const w of latestFirst) {
    const info = { weekId: w.weekId, wonAs: w.displayName || '' };
    if (!isManualId(w.userId)) put(byAccount, w.userId, info);
    put(byPhone, phoneKey(w.mobileNumber), info);
    put(byPhone, profileMobile.get(w.userId), info);
    for (const d of devices.get(w.userId) || []) put(byDevice, d, info);
    put(byName, nameKey(w.displayName), info);
  }
  return { byAccount, byPhone, byDevice, byName, winners: (winners || []).length };
}

/**
 * Check one person against the index.
 * @param {{userId?, name?, mobile?, deviceIds?}} person
 * @returns {{ pastWin: {reason, weekId, wonAs}|null, nameMatch: {weekId, wonAs}|null }}
 *   pastWin keeps them out of the lottery; nameMatch is only a warning.
 */
function matchPastWinner(person, index) {
  const p = person || {};
  const hit = (reason, info) => ({ reason, weekId: info.weekId, wonAs: info.wonAs });
  let pastWin = null;
  if (p.userId && !isManualId(p.userId) && index.byAccount.has(p.userId)) pastWin = hit('account', index.byAccount.get(p.userId));
  const phone = phoneKey(p.mobile);
  if (!pastWin && phone && index.byPhone.has(phone)) pastWin = hit('phone', index.byPhone.get(phone));
  if (!pastWin) {
    const d = (p.deviceIds || []).find((x) => index.byDevice.has(x));
    if (d) pastWin = hit('device', index.byDevice.get(d));
  }
  const name = nameKey(p.name);
  const nameInfo = !pastWin && name ? index.byName.get(name) : null;
  return { pastWin, nameMatch: nameInfo ? { weekId: nameInfo.weekId, wonAs: nameInfo.wonAs } : null };
}

/** Every real winner of every OTHER week, indexed. */
async function loadPastWinnerIndex(weekId) {
  const winners = await QuizWinner.find({ weekId: { $nin: [weekId, TEST_WEEK_MONDAY] }, isTest: { $ne: true } })
    .select('weekId userId displayName mobileNumber').lean();
  const realIds = [...new Set((winners || []).map((w) => w.userId).filter((id) => id && !isManualId(id)))];
  let profiles = [];
  let devices = new Map();
  if (realIds.length) {
    profiles = await User.find({ googleId: { $in: realIds } }).select('googleId mobileNumber').lean();
    const rows = await QuizEntry.aggregate([
      { $match: { userId: { $in: realIds }, deviceId: { $ne: null } } },
      { $group: { _id: '$userId', deviceIds: { $addToSet: '$deviceId' } } },
    ]);
    devices = new Map((rows || []).map((r) => [r._id, (r.deviceIds || []).filter(Boolean)]));
  }
  return buildPastWinnerIndex(winners, profiles, devices);
}

/**
 * Screen this week's players against every past winner.
 * @returns {Map<userId, {name, pastWin, nameMatch}>}
 */
async function screenPastWinners(weekId, userIds) {
  const out = new Map();
  if (!userIds || !userIds.length) return out;
  const [index, users, devs] = await Promise.all([
    loadPastWinnerIndex(weekId),
    User.find({ googleId: { $in: userIds } }).select('googleId displayName mobileNumber').lean(),
    deviceIdsByUser(weekId),
  ]);
  const uMap = new Map((users || []).map((u) => [u.googleId, u]));
  for (const id of userIds) {
    const u = uMap.get(id) || {};
    const m = matchPastWinner({ userId: id, name: u.displayName, mobile: u.mobileNumber, deviceIds: devs.get(id) || [] }, index);
    out.set(id, { name: u.displayName || '', ...m });
  }
  return out;
}

module.exports = { phoneKey, nameKey, buildPastWinnerIndex, matchPastWinner, loadPastWinnerIndex, screenPastWinners };
