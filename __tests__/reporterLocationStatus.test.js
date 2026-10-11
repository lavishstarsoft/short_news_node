'use strict';

const { computeOpportunity } = require('../controllers/reporterLocationStatusController');

describe('computeOpportunity — dynamic gauge from TODAY\'s area news (clamped 10–90%)', () => {
  test('no news today → the max (90%), NOT 100%', () => {
    const o = computeOpportunity(0, {});
    expect(o.percent).toBe(90);
    expect(o.band).toBe('high');
    expect(o.rule.provisional).toBe(true);
    expect(o.rule.name).toBe('area_news_today');
  });

  test('output always stays within 10–90 (never 0%, never 100%)', () => {
    for (const c of [0, 1, 2, 3, 5, 10, 50, 1000]) {
      const p = computeOpportunity(c, {}).percent;
      expect(p).toBeGreaterThanOrEqual(10);
      expect(p).toBeLessThanOrEqual(90);
    }
  });

  test('more news today → lower opportunity, smoothly (dynamic values, not a cliff)', () => {
    const p = [0, 1, 2, 3, 4].map((c) => computeOpportunity(c, {}).percent);
    expect(p).toEqual([90, 81, 74, 67, 60]); // decay 10
    for (let i = 1; i < p.length; i++) expect(p[i]).toBeLessThan(p[i - 1]);
  });

  test('heavy activity floors at 10% (never below)', () => {
    expect(computeOpportunity(30, {}).percent).toBe(10);
    expect(computeOpportunity(1000, {}).percent).toBe(10);
  });

  test('LOW starts at 12+ news today (High 0–4, Medium 5–11, Low 12+)', () => {
    expect(computeOpportunity(0, {}).band).toBe('high');    // 90%
    expect(computeOpportunity(4, {}).band).toBe('high');    // 60%
    expect(computeOpportunity(5, {}).band).toBe('medium');  // 55%
    expect(computeOpportunity(11, {}).band).toBe('medium'); // 30%
    expect(computeOpportunity(12, {}).band).toBe('low');    // 27%
  });

  test('env overrides clamps + decay (tunable without code change)', () => {
    const env = { REPORTER_OPP_MAX: '80', REPORTER_OPP_MIN: '15', REPORTER_OPP_DECAY: '4' };
    expect(computeOpportunity(0, env).percent).toBe(80);
    expect(computeOpportunity(1000, env).percent).toBe(15);
    expect(computeOpportunity(0, env).rule.maxPercent).toBe(80);
  });

  test('handles junk input safely', () => {
    expect(() => computeOpportunity(undefined, {})).not.toThrow();
    expect(computeOpportunity(undefined, {}).percent).toBe(90);
    expect(computeOpportunity(-5, {}).percent).toBe(90); // negatives clamped to 0 count
  });
});
