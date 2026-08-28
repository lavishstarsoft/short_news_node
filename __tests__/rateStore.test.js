'use strict';

/** Distributed rate-limit store: delegates to Redis, and FAILS OPEN on any Redis trouble. */

let mockRedisAvailable = true;
const mockIncrement = jest.fn();
const mockInit = jest.fn();

jest.mock('rate-limit-redis', () => ({
  RedisStore: jest.fn().mockImplementation(() => ({
    init: mockInit,
    increment: mockIncrement,
    decrement: jest.fn(),
    resetKey: jest.fn(),
  })),
}));
jest.mock('../config/redis', () => ({
  redisClient: { sendCommand: jest.fn() },
  isRedisAvailable: () => mockRedisAvailable,
}));

const { createRedisRateStore } = require('../middleware/redisRateStore');

beforeEach(() => { mockRedisAvailable = true; mockIncrement.mockReset(); mockInit.mockReset(); });

test('delegates to the Redis store when available (shared/global counter)', async () => {
  mockIncrement.mockResolvedValue({ totalHits: 5, resetTime: new Date() });
  const store = createRedisRateStore('rl:test:');
  store.init({ windowMs: 1000 });
  const r = await store.increment('1.2.3.4');
  expect(r.totalHits).toBe(5);
  expect(mockIncrement).toHaveBeenCalledWith('1.2.3.4');
});

test('FAILS OPEN when Redis is unavailable → request allowed, Redis not touched', async () => {
  mockRedisAvailable = false;
  const store = createRedisRateStore('rl:test:');
  store.init({ windowMs: 1000 });
  const r = await store.increment('1.2.3.4');
  expect(r.totalHits).toBe(1); // below any max → allowed
  expect(r.resetTime).toBeInstanceOf(Date);
  expect(mockIncrement).not.toHaveBeenCalled();
});

test('FAILS OPEN when the Redis command throws → request still allowed', async () => {
  mockIncrement.mockRejectedValue(new Error('READONLY / connection lost'));
  const store = createRedisRateStore('rl:test:');
  store.init({ windowMs: 1000 });
  const r = await store.increment('1.2.3.4');
  expect(r.totalHits).toBe(1);
});
