const {
  normalizeSchedulePayload,
  resolveScheduledIsActive,
  getAdDisplayStatus,
  isAdPubliclyVisible
} = require('../services/adScheduleService');

describe('adScheduleService', () => {
  const start = new Date('2026-07-10T09:00:00');
  const end = new Date('2026-07-15T18:00:00');

  test('requires start and end when schedule enabled', () => {
    expect(() => normalizeSchedulePayload({ scheduleEnabled: true })).toThrow();
  });

  test('scheduled ad is inactive before start', () => {
    const ad = {
      scheduleEnabled: true,
      scheduleStart: start,
      scheduleEnd: end,
      isActive: true
    };

    expect(resolveScheduledIsActive(ad, new Date('2026-07-09T12:00:00'))).toBe(false);
    expect(getAdDisplayStatus(ad, new Date('2026-07-09T12:00:00'))).toBe('scheduled');
    expect(isAdPubliclyVisible(ad, new Date('2026-07-09T12:00:00'))).toBe(false);
  });

  test('scheduled ad is active during window', () => {
    const ad = {
      scheduleEnabled: true,
      scheduleStart: start,
      scheduleEnd: end,
      isActive: false
    };

    expect(resolveScheduledIsActive(ad, new Date('2026-07-12T12:00:00'))).toBe(true);
    expect(getAdDisplayStatus(ad, new Date('2026-07-12T12:00:00'))).toBe('live');
    expect(isAdPubliclyVisible(ad, new Date('2026-07-12T12:00:00'))).toBe(true);
  });

  test('scheduled ad is inactive after end', () => {
    const ad = {
      scheduleEnabled: true,
      scheduleStart: start,
      scheduleEnd: end,
      isActive: true
    };

    expect(resolveScheduledIsActive(ad, new Date('2026-07-16T08:00:00'))).toBe(false);
    expect(getAdDisplayStatus(ad, new Date('2026-07-16T08:00:00'))).toBe('expired');
    expect(isAdPubliclyVisible(ad, new Date('2026-07-16T08:00:00'))).toBe(false);
  });
});
