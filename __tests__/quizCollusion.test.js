'use strict';

/** Fair-play grouping: Union-Find + the crucial family-safety property. */

const store = { devRows: [], userRows: [] };

jest.mock('../models/QuizEntry', () => ({
  aggregate: jest.fn(async () => store.devRows), // deviceId-per-user grouping
}));
jest.mock('../models/User', () => ({
  find: jest.fn(() => ({ select: () => ({ lean: async () => store.userRows }) })),
}));

const { clusterBySharedKeys, deviceFlagsForWinners, analyzeCollusion } = require('../services/quizCollusionService');

beforeEach(() => { store.devRows = []; store.userRows = []; });

describe('clusterBySharedKeys (pure union-find)', () => {
  test('accounts sharing a device are grouped; unrelated stay separate', () => {
    const { clusters, clusterOf } = clusterBySharedKeys([
      { userId: 'A', keys: ['dev:D1'] },
      { userId: 'B', keys: ['dev:D1'] },
      { userId: 'C', keys: ['dev:D2'] },
    ]);
    expect(clusterOf.get('A')).toBe(clusterOf.get('B'));
    expect(clusterOf.get('A')).not.toBe(clusterOf.get('C'));
    expect(clusters.map((c) => c.size).sort()).toEqual([1, 2]);
  });

  test('transitive: A~B (D1) and B~C (D2) collapse into one cluster of 3', () => {
    const { clusters } = clusterBySharedKeys([
      { userId: 'A', keys: ['dev:D1'] },
      { userId: 'B', keys: ['dev:D1', 'dev:D2'] },
      { userId: 'C', keys: ['dev:D2'] },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].size).toBe(3);
  });

  test('FAMILY SAFETY: different mobile+PAN are NEVER grouped by strong keys', () => {
    const { clusters } = clusterBySharedKeys([
      { userId: 'mom', keys: ['mob:M1', 'pan:P1'] },
      { userId: 'son', keys: ['mob:M2', 'pan:P2'] },
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.size === 1)).toBe(true);
  });
});

describe('deviceFlagsForWinners', () => {
  test('flags a winner who shares an install with another account', async () => {
    store.devRows = [
      { _id: 'A', deviceIds: ['D1'] },
      { _id: 'B', deviceIds: ['D1'] }, // same phone as A
      { _id: 'C', deviceIds: ['D2'] },
    ];
    const flags = await deviceFlagsForWinners('W', ['A', 'C']);
    expect(flags).toHaveLength(1);
    expect(flags[0].userId).toBe('A');
    expect(flags[0].clusterSize).toBe(2);
    expect(flags[0].sharedWith).toEqual(['B']);
  });

  test('no device data → no flags (crash-safe, never blocks the draw)', async () => {
    store.devRows = [];
    expect(await deviceFlagsForWinners('W', ['A', 'B'])).toEqual([]);
  });
});

describe('analyzeCollusion (admin review report)', () => {
  test('device cluster surfaced for review; family stays out of strong clusters', async () => {
    store.devRows = [
      { _id: 'A', deviceIds: ['D1'] },
      { _id: 'B', deviceIds: ['D1'] }, // same phone, DIFFERENT person
      { _id: 'C', deviceIds: ['D3'] },
    ];
    store.userRows = [
      { googleId: 'A', mobileNumber: '111', panNumber: 'PA', displayName: 'Aaa' },
      { googleId: 'B', mobileNumber: '222', panNumber: 'PB', displayName: 'Bbb' },
      { googleId: 'C', mobileNumber: '333', panNumber: 'PC', displayName: 'Ccc' },
    ];
    const rep = await analyzeCollusion('W');
    expect(rep.deviceClusters).toHaveLength(1);         // ⚠ review: A+B on one phone
    expect(rep.deviceClusters[0].size).toBe(2);
    expect(rep.deviceClusters[0].deviceIds).toContain('D1');
    expect(rep.strongClusters).toHaveLength(0);         // family not auto-grouped
  });

  test('true duplicate: two accounts sharing a PAN → strong cluster', async () => {
    store.devRows = [{ _id: 'X', deviceIds: ['D9'] }, { _id: 'Y', deviceIds: ['D8'] }];
    store.userRows = [
      { googleId: 'X', mobileNumber: '900', panNumber: 'SAMEPAN', displayName: 'X' },
      { googleId: 'Y', mobileNumber: '901', panNumber: 'SAMEPAN', displayName: 'Y' },
    ];
    const rep = await analyzeCollusion('W');
    expect(rep.strongClusters).toHaveLength(1);
    expect(rep.strongClusters[0].size).toBe(2);
  });
});
