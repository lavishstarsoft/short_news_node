'use strict';

/**
 * "Loading…", "undefined", "Select category" — a UI placeholder that was submitted
 * instead of a real choice, because the picker had not finished loading.
 *
 * The reporter web portal offered "Loading..." as a SELECTABLE option, so 377 stories
 * were filed with location "Loading..." and 315 with that category. Such stories match
 * no district and are invisible in district feeds.
 *
 * Whole-value match only: a prefix match would reject the real districts "Nandyal",
 * "Nanded" and "Nandurbar", which all begin with "nan".
 */
const PLACEHOLDERS = new Set([
  'loading', 'undefined', 'null', 'nan', 'n/a', 'na', '-', '--', '...',
  'select', 'choose', 'select location', 'select district', 'select category',
  'choose location', 'choose district', 'choose category',
  'please select', 'please wait', 'please choose',
]);

function isPlaceholderValue(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return false; // empty is handled by the normal required-field rules
  // Nothing but punctuation ("...", "…", "--", "***") is never a real place or category.
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return PLACEHOLDERS.has(t.replace(/[.…\s]+$/, '').toLowerCase());
}

module.exports = { isPlaceholderValue, PLACEHOLDERS };
