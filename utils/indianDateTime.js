const IST = 'Asia/Kolkata';

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatIndianDate(value, options = {}) {
  const date = toDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...options,
  }).format(date);
}

function formatIndianTime(value, options = {}) {
  const date = toDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    ...options,
  }).format(date);
}

function formatIndianDateTime(value, options = {}) {
  const date = toDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: IST,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    ...options,
  }).format(date);
}

// India has a fixed UTC offset of +05:30 (no DST), so a constant offset is exact.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * IST business-day key ("YYYY-MM-DD") for the given date/timestamp.
 * Used as the reward day and the reward referenceId date segment.
 */
function istDateKey(value) {
  const date = toDate(value) || new Date();
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date); // en-CA => "YYYY-MM-DD"
}

/**
 * UTC instants bounding the IST calendar day that contains `value`.
 * Returns a half-open interval [startUTC, endUTC) so it is safe for range queries.
 */
function istDayRange(value) {
  const dateKey = istDateKey(value);
  const [y, m, d] = dateKey.split('-').map(Number);
  // IST midnight (local) expressed as a UTC instant = UTC-midnight minus the IST offset.
  const startUTC = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS);
  const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000); // exclusive upper bound
  return { startUTC, endUTC, dateKey };
}

/**
 * Mongo `_id` range that selects every document created during the IST day of `value`.
 * Uses the ObjectId embedded creation time as the immutable submission timestamp,
 * so no schema field or migration is required. Returns { $gte, $lt }.
 */
function objectIdRangeForIstDay(value) {
  const { startUTC, endUTC } = istDayRange(value);
  const { Types } = require('mongoose');
  return {
    $gte: Types.ObjectId.createFromTime(Math.floor(startUTC.getTime() / 1000)),
    $lt: Types.ObjectId.createFromTime(Math.floor(endUTC.getTime() / 1000)),
  };
}

module.exports = {
  IST,
  formatIndianDate,
  formatIndianTime,
  formatIndianDateTime,
  istDateKey,
  istDayRange,
  objectIdRangeForIstDay,
};
