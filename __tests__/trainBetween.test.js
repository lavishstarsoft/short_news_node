'use strict';

// Trains-between-stations proxy: IRCTC1 response normalising, the journey-date
// default (IRCTC1 needs dateOfJourney), and the honest "unavailable" error when a
// key is configured but the provider fails (never made-up trains for real users).

jest.mock('axios');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// A trimmed IRCTC1 /api/v3/trainBetweenStations item (shape used by real integrations).
const IRCTC_ITEM = {
  train_number: '12727', train_name: 'GODAVARI EXP',
  run_days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  train_src: 'VSKP', train_dstn: 'HYB',
  from_std: '17:45', from_sta: '17:40', to_sta: '05:05', to_std: '05:10',
  from_day: 0, to_day: 1,
  from: 'bza', to: 'SC',
  from_station_name: 'VIJAYAWADA JN~', to_station_name: 'SECUNDERABAD JN',
  duration: '11:20', special_train: false, train_type: 'SF', train_date: '26-09-2026',
  class_type: ['1A', '2A', '3A', 'SL'],
};

describe('normBetween + istToday (pure)', () => {
  let normBetween, istToday;
  beforeAll(() => {
    jest.isolateModules(() => {
      ({ normBetween, istToday } = require('../controllers/trainController')._test);
    });
  });

  test('maps IRCTC1 fields to codes, names, times, +1 day, classes; 7 run days → Daily', () => {
    const { trains } = normBetween({ status: true, data: [IRCTC_ITEM] });
    expect(trains).toHaveLength(1);
    expect(trains[0]).toEqual({
      number: '12727', name: 'GODAVARI EXP',
      from: 'BZA', to: 'SC',
      fromName: 'VIJAYAWADA JN', toName: 'SECUNDERABAD JN',
      departure: '17:45', arrival: '05:05', duration: '11:20',
      runsOn: 'Daily', arrivalDayOffset: 1,
      classes: ['1A', '2A', '3A', 'SL'], trainType: 'SF',
    });
  });

  test('partial run days are joined; arrival falls back to to_std; missing day info → null offset', () => {
    const { trains } = normBetween({ data: [{
      ...IRCTC_ITEM, run_days: ['Mon', 'Thu'], to_sta: '', from_day: undefined,
    }] });
    expect(trains[0].runsOn).toBe('Mon,Thu');
    expect(trains[0].arrival).toBe('05:10');
    expect(trains[0].arrivalDayOffset).toBeNull();
  });

  test('unpadded durations from IRCTC ("5:5" = 5 h 05 m) are zero-padded; normal ones untouched', () => {
    const { trains } = normBetween({ data: [
      { ...IRCTC_ITEM, duration: '5:5' },
      { ...IRCTC_ITEM, duration: '11:20' },
      { ...IRCTC_ITEM, duration: '6:03' },
    ] });
    expect(trains.map((x) => x.duration)).toEqual(['5:05', '11:20', '6:03']);
  });

  test('empty / odd payloads never throw', () => {
    expect(normBetween(null).trains).toEqual([]);
    expect(normBetween({ data: [] }).trains).toEqual([]);
    expect(normBetween({ data: { trains: [] } }).trains).toEqual([]);
  });

  test('istToday is the date in India (UTC+5:30)', () => {
    expect(istToday(Date.parse('2026-09-24T10:00:00Z'))).toBe('2026-09-24');
    expect(istToday(Date.parse('2026-09-24T19:00:00Z'))).toBe('2026-09-25'); // 00:30 IST next day
    expect(istToday(Date.parse('2026-09-24T18:29:00Z'))).toBe('2026-09-24'); // 23:59 IST
  });
});

describe('GET /train/between with a key configured', () => {
  let ctrl, axios;
  beforeAll(() => {
    process.env.RAPIDAPI_KEY = 'test-key';
    jest.isolateModules(() => {
      axios = require('axios');
      ctrl = require('../controllers/trainController');
    });
  });
  afterAll(() => { delete process.env.RAPIDAPI_KEY; });
  beforeEach(() => axios.get.mockReset());

  test('no date → sends today (IST) as dateOfJourney and returns live normalised trains', async () => {
    axios.get.mockResolvedValue({ data: { status: true, data: [IRCTC_ITEM] } });
    const res = mockRes();
    await ctrl.between({ query: { from: 'bza', to: 'sc' } }, res);
    const [url, opts] = axios.get.mock.calls[0];
    expect(url).toMatch(/\/api\/v3\/trainBetweenStations$/);
    expect(opts.params).toEqual({ fromStationCode: 'BZA', toStationCode: 'SC', dateOfJourney: ctrl._test.istToday() });
    expect(res.statusCode).toBe(200);
    expect(res.body.source).toBe('live');
    expect(res.body.trains[0].from).toBe('BZA');
  });

  test('a valid date is passed through; a malformed one falls back to today', async () => {
    axios.get.mockResolvedValue({ data: { data: [] } });
    await ctrl.between({ query: { from: 'KMT', to: 'BZA', date: '2026-10-02' } }, mockRes());
    expect(axios.get.mock.calls[0][1].params.dateOfJourney).toBe('2026-10-02');
    await ctrl.between({ query: { from: 'KMT', to: 'WL', date: '02-10-2026' } }, mockRes());
    expect(axios.get.mock.calls[1][1].params.dateOfJourney).toBe(ctrl._test.istToday());
  });

  test('provider failure (e.g. 429 quota) → 503 honest error, NO made-up trains', async () => {
    axios.get.mockRejectedValue(Object.assign(new Error('quota'), { response: { status: 429 } }));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = mockRes();
    await ctrl.between({ query: { from: 'SC', to: 'VSKP' } }, res);
    spy.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(res.body.source).toBe('unavailable');
    expect(res.body.trains).toBeUndefined();
    expect(res.body.error).toMatch(/temporarily unavailable/i);
  });

  test('failures are not cached — the next call retries the provider', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    axios.get.mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 500 } }));
    await ctrl.between({ query: { from: 'GNT', to: 'TEL' } }, mockRes());
    axios.get.mockResolvedValueOnce({ data: { data: [IRCTC_ITEM] } });
    const res = mockRes();
    await ctrl.between({ query: { from: 'GNT', to: 'TEL' } }, res);
    spy.mockRestore();
    expect(res.body.source).toBe('live');
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  test('missing station codes → 400', async () => {
    const res = mockRes();
    await ctrl.between({ query: { from: 'SC' } }, res);
    expect(res.statusCode).toBe(400);
    expect(axios.get).not.toHaveBeenCalled();
  });
});

describe('GET /train/between with NO key (local dev)', () => {
  test('serves clearly-labelled mock data without calling the provider', async () => {
    delete process.env.RAPIDAPI_KEY;
    let ctrl, axios;
    jest.isolateModules(() => {
      axios = require('axios');
      ctrl = require('../controllers/trainController');
    });
    axios.get.mockReset();
    const res = mockRes();
    await ctrl.between({ query: { from: 'SC', to: 'BZA' } }, res);
    expect(axios.get).not.toHaveBeenCalled();
    expect(res.body.source).toBe('mock');
    expect(res.body.trains.length).toBeGreaterThan(0);
  });
});
