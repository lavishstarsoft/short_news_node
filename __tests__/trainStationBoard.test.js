'use strict';

// Station departure board: IRCTC1 getLiveStation (trains due at a station in the next
// N hours) + each train's liveTrainStatus for expected time / delay / platform /
// origin → destination. Fixtures are trimmed REAL responses (Khammam, 2026-09-25 09:48 IST).

jest.mock('axios');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const IST = (s) => Date.parse(`${s}+05:30`);
const NOW = IST('2026-09-25T09:48:00');

const DAILY = { sun: true, mon: true, tue: true, wed: true, thu: true, fri: true, sat: true };
const row = (trainNumber, trainName, arrivalTime, departureTime, runDays = DAILY, trainType = 'MAIL EXPRESS') =>
  ({ trainType, trainNumber, trainName, runDays, arrivalTime, departureTime, classes: [{ value: 'SL', name: 'CLASS - Sleeper' }] });

const KMT_BOARD = {
  status: true,
  data: [
    row('67245', 'VIJAYAWADA - BHADRACHALAM ROAD MEMU', '10:03', '10:04', DAILY, 'MAIN LINE ELECTRICAL MULTIPLE UNIT'),
    row('17406', 'Krishna Express', '34:34', '34:35'),
    row('12706', 'Intercity SF Express', '11:29', '11:30', DAILY, 'INTERCITY'),
    row('20626', 'Bhagat Ki Kothi - MGR Chennai Central SF Express', '37:24', '37:25',
      { sun: true, mon: true, tue: false, wed: true, thu: true, fri: true, sat: false }),
  ],
};

// liveTrainStatus 17406 startDay 1 — running, KMT still ahead (real shape, trimmed).
const KRISHNA_LIVE = {
  data: {
    train_number: '17406', train_name: 'Krishna Express',
    source: 'ADB', destination: 'TPTY', source_stn_name: 'ADILABAD', dest_stn_name: 'TIRUPATI',
    status: 'T', delay: 12, ahead_distance_text: '6 kms ahead', status_as_of: 'As of 1 min ago',
    current_station_code: 'TAA', current_station_name: 'TADLA PUSAPALLI~', si_no: 99,
    cur_stn_sta: '09:32', cur_stn_std: '09:32', eta: '09:44', etd: '09:44', distance_from_source: 694, stoppage_number: 0,
    previous_stations: [
      { si_no: 1, station_code: 'ADB', station_name: 'ADILABAD', distance_from_source: 0, sta: '21:05', std: '21:05', eta: '21:05', etd: '21:05', arrival_delay: 0, platform_number: 1, non_stops: [] },
    ],
    upcoming_stations: [
      { si_no: 0, station_code: '', non_stops: [] },
      { si_no: 106, station_code: 'KMT', station_name: 'KHAMMAM', distance_from_source: 741, sta: '10:34', std: '10:35', eta: '10:35', etd: '10:36', arrival_delay: 1, platform_number: 1, non_stops: [] },
    ],
  },
};

// 67245 at 09:48: "Awaiting Update." — no station arrays at all (real).
const MEMU_AWAITING = {
  data: {
    train_number: '67245', train_name: 'VIJAYAWADA - BHADRACHALAM ROAD MEMU',
    source: 'BZA', destination: 'BDCR', source_stn_name: 'VIJAYAWADA JN', dest_stn_name: 'BHADRACHALAM RD',
    title: 'Awaiting Update.', new_message: 'Train starts at 08:00 but we are still waiting for an update.',
    platform_number: 1,
  },
};

describe('normBoard + boardView (pure)', () => {
  let t;
  beforeAll(() => { jest.isolateModules(() => { t = require('../controllers/trainController')._test; }); });

  test('IRCTC day-counted times → clock time, absolute time, run start day; sorted by time', () => {
    const { trains } = t.normBoard(KMT_BOARD, NOW);
    expect(trains.map((x) => x.number)).toEqual(['67245', '17406', '12706', '20626']);
    const k = trains.find((x) => x.number === '17406');
    expect(k).toMatchObject({ name: 'Krishna Express', arrival: '10:34', departure: '10:35', runsOn: 'Daily', startDay: 1 });
    expect(k.at).toBe(IST('2026-09-25T10:34:00'));
    const bgkt = trains.find((x) => x.number === '20626');
    expect(bgkt).toMatchObject({ arrival: '13:24', startDay: 1, runsOn: 'Sun,Mon,Wed,Thu,Fri' });
    expect(trains[0]).toMatchObject({ number: '67245', arrival: '10:03', startDay: 0, type: 'Main Line Electrical Multiple Unit' });
  });

  test('a window across midnight: early-morning times are tomorrow (run start day one less)', () => {
    const late = IST('2026-09-25T22:30:00');
    const { trains } = t.normBoard({ data: [row('12670', 'Ganga Kaveri Express', '51:04', '51:05'), row('12727', 'Godavari', '23:10', '23:12')] }, late);
    expect(trains.map((x) => x.number)).toEqual(['12727', '12670']);
    const gk = trains[1];
    expect(gk.at).toBe(IST('2026-09-26T03:04:00'));
    expect(gk.startDay).toBe(1); // due on the 26th, 2 days into its run → it left its origin on the 24th = 1 day before today
    expect(trains[0]).toMatchObject({ at: IST('2026-09-25T23:10:00'), startDay: 0 });
  });

  test('a train listed right at its time stays today (not tomorrow)', () => {
    const { trains } = t.normBoard({ data: [row('67245', 'MEMU', '09:40', '09:41')] }, NOW);
    expect(trains[0].at).toBe(IST('2026-09-25T09:40:00'));
  });

  test('odd rows are skipped, never throw', () => {
    expect(t.normBoard(null).trains).toEqual([]);
    expect(t.normBoard({ data: [{ trainNumber: 'x' }, row('12345', 'A', '', '')] }).trains).toEqual([]);
  });

  test('boardView: upcoming — expected time, delay from the times, platform, origin → destination', () => {
    const v = t.boardView(t.normLive(KRISHNA_LIVE), 'KMT');
    expect(v).toMatchObject({
      state: 'upcoming', sta: '10:34', eta: '10:35', delayMinutes: 1, platform: '1',
      originCode: 'ADB', originName: 'Adilabad', destCode: 'TPTY', destName: 'Tirupati',
    });
  });

  test('boardView: at the station now / already left', () => {
    const at = JSON.parse(JSON.stringify(KRISHNA_LIVE));
    Object.assign(at.data, { current_station_code: 'KMT', current_station_name: 'KHAMMAM', ahead_distance_text: 'At station', si_no: 106 });
    at.data.previous_stations.push(at.data.upcoming_stations.pop());
    expect(t.boardView(t.normLive(at), 'KMT').state).toBe('at');
    at.data.ahead_distance_text = 'Just left';
    expect(t.boardView(t.normLive(at), 'KMT').state).toBe('departed');
    at.data.current_station_code = 'MDKI';
    expect(t.boardView(t.normLive(at), 'KMT').state).toBe('departed');
  });

  test('boardView: no route yet (awaiting update / not started) → unknown, origin → destination still known', () => {
    const v = t.boardView(t.normLive(MEMU_AWAITING), 'KMT');
    expect(v).toMatchObject({ state: 'unknown', originCode: 'BZA', originName: 'Vijayawada Jn', destCode: 'BDCR', destName: 'Bhadrachalam Rd' });
    expect(v.note).toMatch(/Train starts at 08:00/);
  });

  test('boardView: platform 0 / -1 hidden; late across midnight counted right', () => {
    const d = JSON.parse(JSON.stringify(KRISHNA_LIVE));
    Object.assign(d.data.upcoming_stations[1], { platform_number: -1, sta: '23:50', eta: '00:20', arrival_delay: 0 });
    const v = t.boardView(t.normLive(d), 'KMT');
    expect(v.platform).toBe('');
    expect(v.delayMinutes).toBe(30);
  });
});

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

describe('GET /train/station (key configured)', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] }));
  afterEach(() => { jest.useRealTimers(); delete process.env.RAPIDAPI_KEY; });

  test('asks IRCTC once per station+window, caches it, returns sorted trains', async () => {
    const { ctrl, axios } = load();
    axios.get.mockResolvedValue({ data: KMT_BOARD });
    const res = mockRes();
    await ctrl.station({ query: { code: 'kmt', hours: '4' } }, res);
    expect(axios.get).toHaveBeenCalledTimes(1);
    const [url, opts] = axios.get.mock.calls[0];
    expect(url).toMatch(/\/api\/v3\/getLiveStation$/);
    expect(opts.params).toEqual({ fromStationCode: 'KMT', hours: '4' });
    expect(res.body).toMatchObject({ source: 'live', station: 'KMT', hours: 4, to: '', toUnavailable: false });
    expect(res.body.trains.map((x) => x.number)).toEqual(['67245', '17406', '12706', '20626']);
    await ctrl.station({ query: { code: 'KMT', hours: '4' } }, mockRes());
    expect(axios.get).toHaveBeenCalledTimes(1); // cached
  });

  test('unknown window → 8 hours; bad codes → 400', async () => {
    const { ctrl, axios } = load();
    axios.get.mockResolvedValue({ data: KMT_BOARD });
    const res = mockRes();
    await ctrl.station({ query: { code: 'KMT', hours: '99' } }, res);
    expect(axios.get.mock.calls[0][1].params.hours).toBe('8');
    const bad = mockRes();
    await ctrl.station({ query: { code: 'K M T' } }, bad);
    expect(bad.statusCode).toBe(400);
  });

  test('a late train keeps showing after it drops out of IRCTC\'s forward window (marked past)', async () => {
    const { ctrl, axios } = load();
    axios.get.mockResolvedValueOnce({ data: KMT_BOARD });
    await ctrl.station({ query: { code: 'KMT', hours: '4' } }, mockRes());
    jest.setSystemTime(IST('2026-09-25T10:20:00')); // board cache (5 min) expired; 67245 (10:03) gone upstream
    axios.get.mockResolvedValueOnce({ data: { data: KMT_BOARD.data.slice(1) } });
    const res = mockRes();
    await ctrl.station({ query: { code: 'KMT', hours: '4' } }, res);
    expect(axios.get).toHaveBeenCalledTimes(2);
    const memu = res.body.trains.find((x) => x.number === '67245');
    expect(memu).toMatchObject({ past: true, arrival: '10:03' });
    expect(res.body.trains[0].number).toBe('67245');
    jest.setSystemTime(IST('2026-09-25T13:00:00')); // > 2.5 h later → forgotten
    axios.get.mockResolvedValueOnce({ data: { data: [] } });
    const later = mockRes();
    await ctrl.station({ query: { code: 'KMT', hours: '4' } }, later);
    expect(later.body.trains.find((x) => x.number === '67245')).toBeUndefined();
  });

  test('"to" keeps only trains IRCTC lists from this station to it (per date); failure → all + flag', async () => {
    const { ctrl, axios } = load();
    axios.get.mockImplementation(async (url, { params }) => {
      if (/getLiveStation/.test(url)) return { data: KMT_BOARD };
      if (/trainBetweenStations/.test(url)) {
        expect(params).toEqual({ fromStationCode: 'KMT', toStationCode: 'SC', dateOfJourney: '2026-09-25' });
        return { data: { data: [{ train_number: '12706', train_name: 'Intercity', from: 'KMT', to: 'SC' }] } };
      }
      throw new Error('unexpected ' + url);
    });
    const res = mockRes();
    await ctrl.station({ query: { code: 'KMT', to: 'sc' } }, res);
    expect(res.body.to).toBe('SC');
    expect(res.body.trains.map((x) => x.number)).toEqual(['12706']);

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r2 = load();
    r2.axios.get.mockImplementation(async (url) => {
      if (/getLiveStation/.test(url)) return { data: KMT_BOARD };
      throw Object.assign(new Error('quota'), { response: { status: 429 } });
    });
    const res2 = mockRes();
    await r2.ctrl.station({ query: { code: 'KMT', to: 'BZA' } }, res2);
    spy.mockRestore();
    expect(res2.statusCode).toBe(200);
    expect(res2.body.toUnavailable).toBe(true);
    expect(res2.body.trains).toHaveLength(4);
  });

  test('provider failure → 503 honest error, no made-up trains', async () => {
    const { ctrl, axios } = load();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    axios.get.mockRejectedValue(Object.assign(new Error('quota'), { response: { status: 429 } }));
    const res = mockRes();
    await ctrl.station({ query: { code: 'KMT' } }, res);
    spy.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(res.body.trains).toBeUndefined();
  });
});

describe('GET /train/station/live (key configured)', () => {
  afterEach(() => { jest.useRealTimers(); delete process.env.RAPIDAPI_KEY; });

  test('one liveTrainStatus per train+day, shared cache with the live page and the board list', async () => {
    // The board's run days depend on the time of day (10:34 is "today" only before it) — fix "now".
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const { ctrl, axios } = load();
    axios.get.mockImplementation(async (url, { params }) => {
      if (/liveTrainStatus/.test(url)) return { data: params.trainNo === '17406' ? KRISHNA_LIVE : MEMU_AWAITING };
      if (/getLiveStation/.test(url)) return { data: KMT_BOARD };
      throw new Error('unexpected ' + url);
    });
    const res = mockRes();
    await ctrl.stationLive({ query: { code: 'KMT', trains: '17406.1,67245.0,17406.1,bad,99999.7' } }, res);
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(axios.get.mock.calls.map(([, o]) => `${o.params.trainNo}.${o.params.startDay}`).sort()).toEqual(['17406.1', '67245.0']);
    expect(Object.keys(res.body.live).sort()).toEqual(['17406.1', '67245.0']);
    expect(res.body.live['17406.1']).toMatchObject({ state: 'upcoming', eta: '10:35', platform: '1', originName: 'Adilabad' });
    expect(res.body.live['67245.0'].state).toBe('unknown');

    // The live page now gets 17406 day 1 from cache …
    const live = mockRes();
    await ctrl.live({ query: { train: '17406', day: '1' } }, live);
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(live.body.originCode).toBe('ADB');
    // … and the board list carries the known origin/destination + live view.
    const board = mockRes();
    await ctrl.station({ query: { code: 'KMT' } }, board);
    const k = board.body.trains.find((x) => x.number === '17406');
    expect(k).toMatchObject({ originCode: 'ADB', destCode: 'TPTY', live: { state: 'upcoming', delayMinutes: 1 } });
  });

  test('some trains fail → marked error; all fail → 503; nothing valid → 400', async () => {
    const { ctrl, axios } = load();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    axios.get.mockImplementation(async (url, { params }) => {
      if (params.trainNo === '17406') return { data: KRISHNA_LIVE };
      throw Object.assign(new Error('x'), { response: { status: 500 } });
    });
    const res = mockRes();
    await ctrl.stationLive({ query: { code: 'KMT', trains: '17406.1,12706.0' } }, res);
    expect(res.body.live['12706.0']).toEqual({ state: 'error' });
    const all = mockRes();
    await ctrl.stationLive({ query: { code: 'KMT', trains: '12706.0' } }, all);
    expect(all.statusCode).toBe(503);
    const none = mockRes();
    await ctrl.stationLive({ query: { code: 'KMT', trains: 'abc' } }, none);
    expect(none.statusCode).toBe(400);
    spy.mockRestore();
  });

  test('a slow / failed live call is retried once; quota errors are not', async () => {
    const { ctrl, axios } = load();
    axios.get
      .mockRejectedValueOnce(Object.assign(new Error('timeout of 12000ms exceeded'), { code: 'ECONNABORTED' }))
      .mockResolvedValueOnce({ data: KRISHNA_LIVE });
    const res = mockRes();
    await ctrl.stationLive({ query: { code: 'KMT', trains: '17406.1' } }, res);
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(res.body.live['17406.1'].state).toBe('upcoming');

    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    axios.get.mockReset();
    axios.get.mockRejectedValue(Object.assign(new Error('quota'), { response: { status: 429 } }));
    const q = mockRes();
    await ctrl.stationLive({ query: { code: 'KMT', trains: '12706.0' } }, q);
    spy.mockRestore();
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(q.statusCode).toBe(503);
  });

  test('live page: startDay 4 is passed through (IRCTC1 supports 0–4)', async () => {
    const { ctrl, axios } = load();
    axios.get.mockResolvedValue({ data: KRISHNA_LIVE });
    await ctrl.live({ query: { train: '17406', day: '4' } }, mockRes());
    expect(axios.get.mock.calls[0][1].params.startDay).toBe('4');
  });
});

test('no key (local dev) → labelled mock board', async () => {
  delete process.env.RAPIDAPI_KEY;
  let ctrl, axios;
  jest.isolateModules(() => { axios = require('axios'); ctrl = require('../controllers/trainController'); });
  axios.get.mockReset();
  const res = mockRes();
  await ctrl.station({ query: { code: 'KMT' } }, res);
  expect(axios.get).not.toHaveBeenCalled();
  expect(res.body.source).toBe('mock');
  expect(res.body.trains.length).toBeGreaterThan(0);
});
