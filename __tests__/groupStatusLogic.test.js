'use strict';

const {
  shouldSuppressDraft,
  filterDraftsAgainstDismissed,
  memberIdSet,
} = require('../services/aiInsights/groupStatusLogic');

describe('groupStatusLogic suppression', () => {
  test('exact match is suppressed', () => {
    const dismissed = [memberIdSet(['a', 'b'])];
    expect(shouldSuppressDraft(['b', 'a'], dismissed)).toBe(true);
  });

  test('subset of dismissed is suppressed', () => {
    const dismissed = [memberIdSet(['a', 'b', 'c'])];
    expect(shouldSuppressDraft(['a', 'b'], dismissed)).toBe(true);
  });

  test('superset with new article resurfaces', () => {
    const dismissed = [memberIdSet(['a', 'b'])];
    expect(shouldSuppressDraft(['a', 'b', 'c'], dismissed)).toBe(false);
  });

  test('unrelated cluster is kept', () => {
    const dismissed = [memberIdSet(['a', 'b'])];
    expect(shouldSuppressDraft(['x', 'y'], dismissed)).toBe(false);
  });

  test('filterDraftsAgainstDismissed counts suppressed', () => {
    const drafts = [
      { memberNewsIds: ['a', 'b'] },
      { memberNewsIds: ['a', 'b', 'c'] },
      { memberNewsIds: ['x', 'y'] },
    ];
    const dismissed = [{ memberNewsIds: ['a', 'b'] }];
    const { kept, suppressed } = filterDraftsAgainstDismissed(drafts, dismissed);
    expect(suppressed).toBe(1);
    expect(kept).toHaveLength(2);
    expect(kept.map((d) => d.memberNewsIds.join(','))).toEqual(['a,b,c', 'x,y']);
  });
});
