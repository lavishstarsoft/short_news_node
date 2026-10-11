'use strict';

// "All days" trains between stations (date=all): IRCTC1 only answers per boarding date,
// so the server asks for the next 7 dates and merges by train number — the app greys the
// trains not running today (Where-is-my-Train style). Verified against the real feed:
// a date's list holds only trains leaving the from-station that day (e.g. KMT→SC Fri adds
// 17048 / 18111, run_days = Fri).

jest.mock('axios');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const item = (no, name, dep, runDays) => ({
  train_number: no, train_name: name, run_days: runDays,
  from_std: dep, to_sta: '14:00', from_day: 0, to_day: 0,
  from: 'KMT', to: 'SC', from_station_name: 'KHAMMAM', to_station_name: 'SECUNDERABAD JN',
  duration: '5:20', train_type: 'EXP', class_type: ['SL'],
});
const DAILY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GOLCONDA = item('17201', 'Golconda Express', '08:45', DAILY);
const WEEKLY_A = item('17048', 'Charlapalli Express', '01:35', ['Fri']);
const WEEKLY_B = item('18111', 'Yesvantpur Weekly', '16:10', ['Fri']);
const SHIRDI = item('17206', 'Sainagar Shirdi Express', '11:10', ['Mon', 'Wed', 'Sat']);

function load() {
  process.env.RAPIDAPI_KEY = 'test-key';
  let ctrl, axios;
  jest.isolateModules(() => {
    axios = require('axios');
    ctrl = require('../controllers/trainController');
  });
  axios.get.mockReset();
  return { ctrl, axios };
}

const next7 = (ctrl) => Array.from({ length: 7 }, (_, i) => ctrl._test.istToday(Date.now() + i * 864e5));

afterEach(() => {
  delete process.env.RAPIDAPI_KEY;
  jest.useRealTimers();
});

test('date=all asks IRCTC for the next 7 boarding dates and merges every train once, sorted by departure', async () => {
  const { ctrl, axios } = load();
  const dates = next7(ctrl);
  axios.get.mockImplementation(async (url, { params }) => {
    const i = dates.indexOf(params.dateOfJourney);
    const list = [GOLCONDA];
    if (i === 1) list.push(WEEKLY_A, WEEKLY_B);
    if (i === 4) list.push(SHIRDI);
    return { data: { status: true, data: list } };
  });
  const res = mockRes();
  await ctrl.between({ query: { from: 'kmt', to: 'sc', date: 'all' } }, res);

  expect(axios.get).toHaveBeenCalledTimes(7);
  expect(axios.get.mock.calls.map(([, o]) => o.params.dateOfJourney)).toEqual(dates);
  expect(axios.get.mock.calls.every(([u, o]) => /trainBetweenStations$/.test(u) && o.params.fromStationCode === 'KMT' && o.params.toStationCode === 'SC')).toBe(true);
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ source: 'live', allDays: true, incomplete: false, days: 7 });
  expect(res.body.trains.map((t) => t.number)).toEqual(['17048', '17201', '17206', '18111']); // 01:35, 08:45, 11:10, 16:10
  expect(res.body.trains.find((t) => t.number === '17206').runsOn).toBe('Mon,Wed,Sat'); // weekly pattern kept
  expect(res.body.trains.find((t) => t.number === '17201').runsOn).toBe('Daily');
});

test('the merged list is cached (7 days) and shared; the per-date results serve the date view too', async () => {
  const { ctrl, axios } = load();
  axios.get.mockResolvedValue({ data: { data: [GOLCONDA] } });
  await ctrl.between({ query: { from: 'KMT', to: 'SC', date: 'all' } }, mockRes());
  expect(axios.get).toHaveBeenCalledTimes(7);

  const again = mockRes();
  await ctrl.between({ query: { from: 'KMT', to: 'SC', date: 'all' } }, again);
  expect(again.body.allDays).toBe(true);
  const today = mockRes();
  await ctrl.between({ query: { from: 'KMT', to: 'SC', date: ctrl._test.istToday() } }, today);
  expect(today.body.trains.map((t) => t.number)).toEqual(['17201']);
  expect(axios.get).toHaveBeenCalledTimes(7); // no new upstream calls
  expect(ctrl._test.ALL_DAYS_TTL).toBe(7 * 24 * 3600e3);
});

test('concurrent first requests for a route share one set of 7 calls', async () => {
  const { ctrl, axios } = load();
  axios.get.mockImplementation(() => new Promise((r) => setTimeout(() => r({ data: { data: [GOLCONDA] } }), 5)));
  const a = mockRes(), b = mockRes();
  await Promise.all([
    ctrl.between({ query: { from: 'KMT', to: 'SC', date: 'all' } }, a),
    ctrl.between({ query: { from: 'KMT', to: 'SC', date: 'all' } }, b),
  ]);
  expect(axios.get).toHaveBeenCalledTimes(7);
  expect(a.body.trains).toEqual(b.body.trains);
});

test('if some days fail the list is still served, marked incomplete, and retried after 10 minutes', async () => {
  jest.useFakeTimers({ now: Date.parse('2026-09-25T06:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  const { ctrl, axios } = load();
  const dates = next7(ctrl);
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  axios.get.mockImplementation(async (url, { params }) => {
    if (params.dateOfJourney === dates[3]) throw Object.assign(new Error('timeout'), { response: { status: 504 } });
    return { data: { data: [GOLCONDA] } };
  });
  const res = mockRes();
  await ctrl.between({ query: { from: 'KMT', to: 'SC', date: 'all' } }, res);
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ allDays: true, incomplete: true, days: 6 });
  expect(res.body.trains.map((t) => t.number)).toEqual(['17201']);

  const calls = axios.get.mock.calls.length;
  await ctrl.between({ query: { from: 'KMT', to: 'SC', date: 'all' } }, mockRes()); // within 10 min → cached
  expect(axios.get.mock.calls.length).toBe(calls);
  jest.advanceTimersByTime(ctrl._test.ALL_DAYS_RETRY_TTL + 1000);
  await ctrl.between({ query: { from: 'KMT', to: 'SC', date: 'all' } }, mockRes()); // retried
  expect(axios.get.mock.calls.length).toBeGreaterThan(calls);
  spy.mockRestore();
});

test('if every day fails → 503 honest error, no made-up trains', async () => {
  const { ctrl, axios } = load();
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  axios.get.mockRejectedValue(Object.assign(new Error('quota'), { response: { status: 429 } }));
  const res = mockRes();
  await ctrl.between({ query: { from: 'KMT', to: 'SC', date: 'all' } }, res);
  spy.mockRestore();
  expect(res.statusCode).toBe(503);
  expect(res.body.source).toBe('unavailable');
  expect(res.body.trains).toBeUndefined();
});

test('no key (local dev) → labelled mock data, no upstream calls', async () => {
  delete process.env.RAPIDAPI_KEY;
  let ctrl, axios;
  jest.isolateModules(() => {
    axios = require('axios');
    ctrl = require('../controllers/trainController');
  });
  axios.get.mockReset();
  const res = mockRes();
  await ctrl.between({ query: { from: 'KMT', to: 'SC', date: 'ALL' } }, res);
  expect(axios.get).not.toHaveBeenCalled();
  expect(res.body).toMatchObject({ source: 'mock', allDays: true });
});
