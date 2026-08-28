'use strict';

/**
 * Fair-play analysis for the weekly prize draw.
 *
 * Groups quiz accounts that likely belong to ONE physical person using Union-Find
 * over shared signals. Two signal strengths, treated very differently on purpose:
 *
 *   • STRONG  (mobile number, PAN): a shared value means literally the same person.
 *     Two family members have DIFFERENT mobile+PAN, so they are NEVER grouped —
 *     zero false positives. (In practice these are unique-constrained at signup, so
 *     strong clusters should be empty; kept as a defensive backstop.)
 *   • WEAK    (per-install deviceId): a shared value means the same phone, which
 *     COULD be a legit family sharing one device. So device clusters are only ever
 *     surfaced for HUMAN REVIEW — never used to auto-block a payout here.
 *
 * The deviceId is client-supplied and therefore untrusted; this module only reads
 * it. Nothing here mutates winners or blocks play.
 */

const QuizEntry = require('../models/QuizEntry');

/**
 * Union-Find grouping: users that share ANY key end up in one cluster (transitive).
 * Keys are hubbed as their own nodes so sharing links users indirectly.
 * @param {Array<{userId:string, keys:string[]}>} nodes
 * @returns {{ clusters: Array<{id,userIds,size}>, clusterOf: Map<string,string> }}
 */
function clusterBySharedKeys(nodes) {
  const parent = new Map();
  const ensure = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; } // path compression
    return r;
  };
  const union = (a, b) => { ensure(a); ensure(b); const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  for (const n of (nodes || [])) {
    const un = 'u:' + n.userId;
    ensure(un);
    for (const k of (n.keys || [])) if (k) union(un, 'k:' + k);
  }

  const groups = new Map();
  for (const n of (nodes || [])) {
    const root = find('u:' + n.userId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(n.userId);
  }

  const clusters = [];
  const clusterOf = new Map();
  let cid = 0;
  for (const userIds of groups.values()) {
    const id = 'c' + (cid++);
    clusters.push({ id, userIds, size: userIds.length });
    for (const u of userIds) clusterOf.set(u, id);
  }
  return { clusters, clusterOf };
}

/** Distinct install ids per user for a week (only submitted entries that carried one). */
async function deviceIdsByUser(weekId) {
  const rows = await QuizEntry.aggregate([
    { $match: { weekId, submittedAt: { $ne: null }, deviceId: { $ne: null } } },
    { $group: { _id: '$userId', deviceIds: { $addToSet: '$deviceId' } } },
  ]);
  const map = new Map();
  for (const r of (rows || [])) {
    const ids = Array.isArray(r.deviceIds) ? r.deviceIds.filter(Boolean) : [];
    map.set(r._id, ids);
  }
  return map;
}

/**
 * For a list of winner userIds, return those who share an install with ANOTHER
 * account that played the same week. Informational only (for a payout review) —
 * it never changes the winner set. Fully crash-safe: returns [] on any error.
 */
async function deviceFlagsForWinners(weekId, winnerUserIds) {
  try {
    const devByUser = await deviceIdsByUser(weekId);
    const nodes = [];
    for (const [userId, deviceIds] of devByUser) nodes.push({ userId, keys: deviceIds.map((d) => 'dev:' + d) });
    const { clusters, clusterOf } = clusterBySharedKeys(nodes);
    const byId = new Map(clusters.map((c) => [c.id, c]));
    const flagged = [];
    for (const uid of (winnerUserIds || [])) {
      const c = byId.get(clusterOf.get(uid));
      if (c && c.size > 1) flagged.push({ userId: uid, clusterSize: c.size, sharedWith: c.userIds.filter((x) => x !== uid) });
    }
    return flagged;
  } catch (_) {
    return [];
  }
}

/**
 * Full fair-play report for an admin to review BEFORE picking winners. Splits the
 * two signal strengths so the admin knows which clusters are "same person" (strong)
 * vs "same phone, please eyeball" (weak/device).
 * @param {string} weekId
 * @param {string[]|null} userIds  restrict to these accounts (default: all who played)
 */
async function analyzeCollusion(weekId, userIds = null) {
  const devByUser = await deviceIdsByUser(weekId);
  const users = (userIds && userIds.length) ? userIds : Array.from(devByUser.keys());

  // Strong identity from the User profile (mobile / PAN).
  const User = require('../models/User');
  const profs = await User.find({ googleId: { $in: users } }).select('googleId mobileNumber panNumber displayName').lean();
  const profById = new Map((profs || []).map((p) => [p.googleId, p]));

  const deviceNodes = users.map((u) => ({ userId: u, keys: (devByUser.get(u) || []).map((d) => 'dev:' + d) }));
  const strongNodes = users.map((u) => {
    const p = profById.get(u) || {};
    const keys = [];
    if (p.mobileNumber) keys.push('mob:' + String(p.mobileNumber).trim());
    if (p.panNumber) keys.push('pan:' + String(p.panNumber).trim().toUpperCase());
    return { userId: u, keys };
  });

  const device = clusterBySharedKeys(deviceNodes);
  const strong = clusterBySharedKeys(strongNodes);

  const nameOf = (u) => (profById.get(u) || {}).displayName || '';
  const decorate = (c) => ({ size: c.size, userIds: c.userIds, names: c.userIds.map(nameOf) });

  const deviceClusters = device.clusters
    .filter((c) => c.size > 1)
    .map((c) => ({ ...decorate(c), deviceIds: [...new Set(c.userIds.flatMap((u) => devByUser.get(u) || []))] }));
  const strongClusters = strong.clusters.filter((c) => c.size > 1).map(decorate);

  return {
    weekId,
    participantsWithDevice: devByUser.size,
    // ⚠️ REVIEW manually — multiple accounts on one install (may be a legit family).
    deviceClusters,
    // 🚫 Same person (shared mobile/PAN). Should be near-empty due to unique signup.
    strongClusters,
  };
}

module.exports = { clusterBySharedKeys, deviceIdsByUser, deviceFlagsForWinners, analyzeCollusion };
