'use strict';

/**
 * Placeholder guard on news create: a picker that is still loading ("Loading…") must
 * never become the stored district or category. 377 live stories were filed with
 * location "Loading..." and 315 with that category before this guard existed — they
 * match no district and are invisible in district feeds.
 */
const { isPlaceholderValue } = require('../utils/placeholderValue');

describe('isPlaceholderValue', () => {
  test('rejects what a half-loaded picker submits', () => {
    for (const v of ['Loading...', 'Loading…', 'loading', 'LOADING', 'undefined', 'null', 'NaN',
      'Select', 'Select Location', 'Select district', 'Choose category', 'Please select',
      'N/A', 'na', '-', '--', '...', '….', '***', '   ...  ']) {
      expect([v, isPlaceholderValue(v)]).toEqual([v, true]);
    }
  });

  test('accepts every real place / category, including look-alike district names', () => {
    // "Nandyal", "Nanded" and "Nandurbar" are real districts starting with "nan";
    // "Null Bazar" (Mumbai) and "Selu" (Maharashtra) are real place names. A prefix
    // match would have wrongly blocked all of them.
    for (const v of ['Nandyal', 'Nanded', 'Nandurbar', 'Nagpur', 'Nalgonda', 'Khammam', 'Bonakal',
      'New Delhi', 'Andhra Pradesh', 'International', 'Jaipur', 'Null Bazar', 'Selu', 'Nashik',
      'Chooseganj', 'Selected Colony', 'విజయవాడ', 'मेरठ', 'NEWS', 'Event/Sports']) {
      expect([v, isPlaceholderValue(v)]).toEqual([v, false]);
    }
  });

  test('empty / missing is left to the normal required-field rules', () => {
    for (const v of ['', '   ', null, undefined]) expect(isPlaceholderValue(v)).toBe(false);
  });
});
