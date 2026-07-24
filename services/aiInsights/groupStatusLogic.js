'use strict';

/**
 * Editorial status rules for AI Duplicate groups.
 *
 * Ignore  = false positive / not a concern. Hide from Open. Suppress on future scans
 *           unless a NEW article joins the cluster (superset → resurface).
 * Archive = reviewed & closed for records. Same suppression as Ignore.
 *           Different tab for admin mental model / audit.
 * Restore = back to Open queue for re-review.
 *
 * News articles are never deleted or unpublished by these actions.
 */

const C = require('./constants');

const STATUS_META = {
  [C.GROUP_STATUS.OPEN]: {
    label: 'Open',
    meaning: 'Needs editorial review',
  },
  [C.GROUP_STATUS.IGNORED]: {
    label: 'Ignored',
    meaning: 'Marked as not a concern (false positive). Hidden from Open and blocked on future scans unless a new article joins.',
  },
  [C.GROUP_STATUS.ARCHIVED]: {
    label: 'Archived',
    meaning: 'Reviewed and closed for records. Hidden from Open and blocked on future scans unless a new article joins.',
  },
  [C.GROUP_STATUS.REVIEWED]: {
    label: 'Reviewed',
    meaning: 'Marked reviewed',
  },
};

function normalizeId(id) {
  return String(id == null ? '' : id).trim();
}

/** Stable sorted unique member id list. */
function memberIdSet(ids) {
  const out = [];
  const seen = new Set();
  for (const raw of ids || []) {
    const id = normalizeId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort();
  return out;
}

function memberSignature(ids) {
  return memberIdSet(ids).join('|');
}

function isSubset(smallSorted, largeSorted) {
  if (smallSorted.length > largeSorted.length) return false;
  const large = new Set(largeSorted);
  return smallSorted.every((id) => large.has(id));
}

/**
 * Suppress draft when its members are an exact match OR a subset of a
 * dismissed (ignored/archived) group. Superset with a new article → allow
 * (admin should see the new member).
 */
function shouldSuppressDraft(draftMemberIds, dismissedMemberSets) {
  const draft = memberIdSet(draftMemberIds);
  if (draft.length < 2) return true;
  for (const dismissed of dismissedMemberSets) {
    if (!dismissed || dismissed.length < 2) continue;
    if (draft.length === dismissed.length && draft.every((id, i) => id === dismissed[i])) {
      return true;
    }
    if (isSubset(draft, dismissed)) {
      return true;
    }
  }
  return false;
}

function filterDraftsAgainstDismissed(drafts, dismissedGroups) {
  const dismissedSets = (dismissedGroups || []).map((g) =>
    memberIdSet(g.memberNewsIds && g.memberNewsIds.length
      ? g.memberNewsIds
      : (g.members || []).map((m) => m.newsId))
  );
  const kept = [];
  let suppressed = 0;
  for (const draft of drafts || []) {
    const ids = draft.memberNewsIds || (draft.members || []).map((m) => m.newsId);
    if (shouldSuppressDraft(ids, dismissedSets)) {
      suppressed += 1;
      continue;
    }
    kept.push(draft);
  }
  return { kept, suppressed };
}

function isClosedStatus(status) {
  return status === C.GROUP_STATUS.IGNORED || status === C.GROUP_STATUS.ARCHIVED;
}

module.exports = {
  STATUS_META,
  memberIdSet,
  memberSignature,
  shouldSuppressDraft,
  filterDraftsAgainstDismissed,
  isClosedStatus,
};
