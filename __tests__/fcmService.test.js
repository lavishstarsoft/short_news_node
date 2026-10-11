'use strict';

// Unit tests for the FCM transport's pure helpers — no credentials, no network.
// Delivery itself needs a Firebase service account + the app's FCM handler;
// here we lock down the payload shape and topic mapping that the app depends on.

const fcm = require('../services/fcmService');
const { stringifyData, sanitizeTopic, languageTopic, userTopic } = fcm._test;

describe('fcmService helpers', () => {
  test('stringifyData coerces every value to a string and drops empties', () => {
    const out = stringifyData({
      title: 'Hello',
      count: 3,
      flag: true,
      nx: { type: 'poll', options: ['a', 'b'] },
      empty: '',
      nothing: null,
      missing: undefined,
    });
    expect(out.title).toBe('Hello');
    expect(out.count).toBe('3');
    expect(out.flag).toBe('true');
    expect(out.nx).toBe('{"type":"poll","options":["a","b"]}');
    expect(out).not.toHaveProperty('empty');
    expect(out).not.toHaveProperty('nothing');
    expect(out).not.toHaveProperty('missing');
    // Every value must be a string (FCM hard requirement).
    Object.values(out).forEach((v) => expect(typeof v).toBe('string'));
  });

  test('sanitizeTopic keeps valid chars and replaces the rest', () => {
    expect(sanitizeTopic('news_te')).toBe('news_te');
    expect(sanitizeTopic('user 12/3@x')).toBe('user_12_3_x');
  });

  test('languageTopic mirrors the OneSignal news_language tag', () => {
    expect(languageTopic('te')).toBe('news_te');
    expect(languageTopic('TE')).toBe('news_te');
    expect(languageTopic('  hi ')).toBe('news_hi');
    expect(languageTopic('')).toBe('news_all'); // unknown → broadcast, never silently nobody
  });

  test('userTopic builds a per-person topic', () => {
    expect(userTopic('650abc')).toBe('user_650abc');
    expect(userTopic('')).toBeNull();
  });

  test('disabled by default — isReady is false without FCM_PUSH_ENABLED', () => {
    expect(fcm.isReady()).toBe(false); // flag unset in tests → dark, safe
  });

  test('sends resolve to a skipped result (never throw) when disabled', async () => {
    const r = await fcm.sendNewsToLanguage('te', { title: 't', message: 'm' });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe('fcm_disabled');
  });
});
