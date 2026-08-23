'use strict';

/**
 * P2 — Tiered reporter daily submission limit (service + reverse In-Charge resolver).
 * Pure logic tests; no DB, no wallet, no routing mutation.
 */

jest.mock('../models/News', () => ({ countDocuments: jest.fn() }));
const News = require('../models/News');
const {
  TIER_DAILY_LIMIT,
  isTierLimited,
  countReporterDailySubmissions,
  LIMIT_MESSAGE,
} = require('../utils/dailyLimitService');
const { resolveReporterStateIncharge } = require('../utils/editorCoverageHelper');
const { objectIdRangeForIstDay } = require('../utils/indianDateTime');

beforeEach(() => News.countDocuments.mockReset());

describe('isTierLimited — only stringer / district_incharge are capped', () => {
  test('null / undefined / legacy → NOT limited (existing reporters unchanged)', () => {
    expect(isTierLimited(null)).toBe(false);
    expect(isTierLimited(undefined)).toBe(false);
    expect(isTierLimited('')).toBe(false);
    expect(isTierLimited('Reporter')).toBe(false);
    expect(isTierLimited('subeditor')).toBe(false);
  });
  test('stringer + district_incharge → limited', () => {
    expect(isTierLimited('stringer')).toBe(true);
    expect(isTierLimited('district_incharge')).toBe(true);
  });
  test('limit constant is 10 and message is exact', () => {
    expect(TIER_DAILY_LIMIT).toBe(10);
    expect(LIMIT_MESSAGE).toBe('You have reached the daily limit of 10 news. Please contact your State In-Charge.');
  });
});

describe('countReporterDailySubmissions — query shape', () => {
  test('filters by author, IST ObjectId day range, and excludes rejected', async () => {
    News.countDocuments.mockResolvedValue(4);
    const when = new Date('2026-08-22T09:00:00.000Z');
    const n = await countReporterDailySubmissions('rep1', when);
    expect(n).toBe(4);
    const q = News.countDocuments.mock.calls[0][0];
    expect(q.authorId).toBe('rep1');
    expect(q['rejectionStatus.isRejected']).toEqual({ $ne: true });
    // Same IST/ObjectId-day semantics used by the reward system.
    expect(q._id).toEqual(objectIdRangeForIstDay(when));
  });

  test('threshold semantics: 9 < limit (allowed), 10 >= limit (blocked)', async () => {
    News.countDocuments.mockResolvedValueOnce(9);
    expect((await countReporterDailySubmissions('r')) >= TIER_DAILY_LIMIT).toBe(false); // 10th allowed
    News.countDocuments.mockResolvedValueOnce(10);
    expect((await countReporterDailySubmissions('r')) >= TIER_DAILY_LIMIT).toBe(true);  // 11th blocked
  });
});

describe('IST midnight boundary (Asia/Kolkata) via objectIdRangeForIstDay', () => {
  test('23:30 IST and 00:30 IST (next day) fall in different day buckets', () => {
    // 2026-08-22 23:30 IST == 18:00Z ; 2026-08-23 00:30 IST == 19:00Z (same UTC date, different IST day)
    const beforeMidnightIst = new Date('2026-08-22T18:00:00.000Z');
    const afterMidnightIst = new Date('2026-08-22T19:00:00.000Z');
    const a = objectIdRangeForIstDay(beforeMidnightIst);
    const b = objectIdRangeForIstDay(afterMidnightIst);
    expect(a.$gte.toString()).not.toBe(b.$gte.toString());
    expect(a.$lt.toString()).toBe(b.$gte.toString()); // day A upper bound == day B lower bound
  });
});

describe('resolveReporterStateIncharge — reverse routing, read-only', () => {
  const reporter = { _id: 'rep1', assignedDistricts: ['Banda'] };
  const fakeAdmin = (subs) => ({
    find: () => ({ select: () => ({ lean: () => Promise.resolve(subs) }) }),
  });

  test('explicit managedReporterIds match wins and returns name + mobile', async () => {
    const ic = await resolveReporterStateIncharge(fakeAdmin([
      { _id: 's1', name: 'Geo Only', mobileNumber: '111', permissions: { managedDistricts: ['Banda'] } },
      { _id: 's2', name: 'Explicit One', mobileNumber: '222', permissions: { managedReporterIds: ['rep1'] } },
    ]), reporter);
    expect(ic).toEqual({ name: 'Explicit One', mobileNumber: '222' });
  });

  test('geography coverage match when no explicit assignment', async () => {
    const ic = await resolveReporterStateIncharge(fakeAdmin([
      { _id: 's1', name: 'Banda SIC', mobileNumber: '999', permissions: { managedDistricts: ['Banda'] } },
      { _id: 's2', name: 'Other', mobileNumber: '000', permissions: { managedDistricts: ['Agra'] } },
    ]), reporter);
    expect(ic).toEqual({ name: 'Banda SIC', mobileNumber: '999' });
  });

  test('prefers a displayRole containing "State In-Charge" among matches', async () => {
    const ic = await resolveReporterStateIncharge(fakeAdmin([
      { _id: 's1', name: 'Plain Sub', mobileNumber: '111', permissions: { managedDistricts: ['Banda'] } },
      { _id: 's2', name: 'The SIC', mobileNumber: '222', displayRole: 'State In-Charge', permissions: { managedDistricts: ['Banda'] } },
    ]), reporter);
    expect(ic).toEqual({ name: 'The SIC', mobileNumber: '222' });
  });

  test('no matching sub-editor → null (generic message path)', async () => {
    const ic = await resolveReporterStateIncharge(fakeAdmin([
      { _id: 's1', name: 'Elsewhere', mobileNumber: '111', permissions: { managedDistricts: ['Agra'] } },
    ]), reporter);
    expect(ic).toBeNull();
  });
});
