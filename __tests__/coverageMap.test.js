'use strict';

/**
 * Coverage Map — pure logic: reporter→state resolution (assignedDistricts/state,
 * never free-text constituency) and IST boundary ObjectIds.
 */

// Mock the heavy model/require chain the controller pulls in at load.
jest.mock('../models/Admin', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/News', () => ({ aggregate: jest.fn() }));
jest.mock('../models/Location', () => ({ find: jest.fn(), countDocuments: jest.fn() }));

const { _internals } = require('../controllers/coverageMapController');
const { reporterStateList, istBoundaryObjIds, norm } = _internals;

const geo = {
  stateSet: new Set(['tamil nadu', 'uttar pradesh', 'gujarat']),
  distToState: new Map([['madurai', 'Tamil Nadu'], ['ghaziabad', 'Uttar Pradesh'], ['kutch', 'Gujarat']]),
};

describe('reporterStateList — uses assignedDistricts/state, not free-text constituency', () => {
  test('assignedDistricts → mapped state', () => {
    expect(reporterStateList({ assignedDistricts: ['Madurai'] }, geo)).toEqual(['Tamil Nadu']);
  });
  test('assignedState direct', () => {
    expect(reporterStateList({ assignedState: 'Gujarat' }, geo)).toEqual(['Gujarat']);
  });
  test('NCR district maps via administrativeState-derived distToState (Ghaziabad→UP)', () => {
    expect(reporterStateList({ assignedDistricts: ['Ghaziabad'] }, geo)).toEqual(['Uttar Pradesh']);
  });
  test('free-text constituency is IGNORED (no state inferred from it)', () => {
    // constituency "Rampachodawaram" is junk — must NOT produce a state.
    expect(reporterStateList({ constituency: 'Rampachodawaram' }, geo)).toEqual([]);
  });
  test('unknown district → no state', () => {
    expect(reporterStateList({ assignedDistricts: ['Nowhere'] }, geo)).toEqual([]);
  });
  test('dedupes multiple signals to same state', () => {
    expect(reporterStateList({ assignedState: 'Tamil Nadu', assignedDistricts: ['Madurai'] }, geo)).toEqual(['Tamil Nadu']);
  });
});

describe('istBoundaryObjIds', () => {
  test('today >= week >= month ordering of embedded timestamps', () => {
    const b = istBoundaryObjIds(Date.UTC(2026, 7, 23, 12, 0, 0));
    expect(b.today.getTimestamp().getTime()).toBeGreaterThanOrEqual(b.week.getTimestamp().getTime());
    expect(b.week.getTimestamp().getTime()).toBeGreaterThanOrEqual(b.month.getTimestamp().getTime());
  });
});

describe('norm', () => {
  test('lowercases + collapses spaces', () => {
    expect(norm('  Tamil   Nadu ')).toBe('tamil nadu');
  });
});
