'use strict';

// PNR status proxy. IRCTC1 v3 getPNRStatus: unknown PNR = HTTP 200 {status:false,
// message:"PNR Not found."} (verified 2026-09-25). Found PNRs come in IRCTC's camelCase
// shape (passengerList / *StatusDetails / chartStatus text) or a PascalCase one
// (PassengerStatus / BookingStatus / ChartPrepared bool) — both are read.

jest.mock('axios');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const CAMEL = {
  status: true,
  data: {
    pnrNumber: '4231234567', dateOfJourney: 'Sep 27, 2026 5:40:00 PM', trainNumber: '12727', trainName: 'GODAVARI EXP',
    sourceStation: 'VSKP', destinationStation: 'HYB', reservationUpto: 'HYB', boardingPoint: 'VSKP', journeyClass: '3A',
    numberOfpassenger: 3, chartStatus: 'Chart Not Prepared', quota: 'GN', bookingFare: 1435, ticketFare: 1435,
    arrivalDate: 'Sep 28, 2026 6:05:00 AM', bookingDate: 'Sep 01, 2026 10:02:11 AM', trainCancelStatus: '',
    passengerList: [
      { passengerSerialNumber: 1, bookingStatus: 'CNF', bookingCoachId: 'B2', bookingBerthNo: 34, bookingBerthCode: 'LB', bookingStatusDetails: 'CNF/B2/34/LB',
        currentStatus: 'CNF', currentCoachId: 'B2', currentBerthNo: 34, currentBerthCode: 'LB', currentStatusDetails: 'CNF/B2/34/LB' },
      { passengerSerialNumber: 2, bookingStatus: 'WL', bookingStatusDetails: 'GNWL/60/GN', currentStatus: 'RAC', currentStatusDetails: 'RAC/15/GN', currentCoachId: '', currentBerthNo: 0 },
      { passengerSerialNumber: 3, bookingStatus: 'WL', bookingStatusDetails: 'RLWL/-/16/GN', currentStatus: 'WL', currentStatusDetails: 'RLWL/-/9/GN' },
    ],
  },
};

const PASCAL = {
  status: true,
  data: {
    Pnr: '4361365838', TrainNo: '18638', TrainName: 'SMVB HTE EXP', Doj: '13-02-2024', BookingDate: '25-01-2024', Quota: 'GN',
    From: 'SMVB', To: 'HTE', ReservationUpto: 'HTE', BoardingPoint: 'SMVB', Class: '3A', ChartPrepared: true,
    BoardingStationName: 'SMVT BENGALURU', TrainCancelledFlag: false, PassengerCount: 1,
    PassengerStatus: [{ Number: 1, Prediction: '67% Chance', PredictionPercentage: '67', Coach: '', Berth: 4, BookingStatus: 'GNWL 72', CurrentStatus: 'GNWL 4' }],
  },
};

describe('normPnr (pure)', () => {
  let t;
  beforeAll(() => { jest.isolateModules(() => { t = require('../controllers/trainController')._test; }); });

  test('IRCTC camelCase: train, route, date, times, chart, fare, seat statuses', () => {
    const o = t.normPnr(CAMEL);
    expect(o).toMatchObject({
      pnr: '4231234567', trainNumber: '12727', trainName: 'Godavari Exp', from: 'VSKP', to: 'HYB', boardingPoint: 'VSKP',
      doj: '2026-09-27', departure: '17:40', arrival: '06:05', arrivalDate: '2026-09-28', travelClass: '3A', quota: 'GN',
      chartPrepared: false, chartStatus: 'Chart Not Prepared', trainCancelled: false, bookingDate: '2026-09-01', fare: 1435,
    });
    expect(o.passengers).toEqual([
      expect.objectContaining({ no: 1, bookingStatus: 'CNF B2 34 LB', currentStatus: 'CNF B2 34 LB', currentKind: 'CNF', coach: 'B2', berth: '34' }),
      expect.objectContaining({ no: 2, bookingStatus: 'GNWL 60', bookingKind: 'WL', currentStatus: 'RAC 15', currentKind: 'RAC', berth: '' }),
      expect.objectContaining({ no: 3, bookingStatus: 'RLWL 16', currentStatus: 'RLWL 9', currentKind: 'WL' }),
    ]);
  });

  test('PascalCase: ChartPrepared bool, dd-mm-yyyy date, prediction', () => {
    const o = t.normPnr(PASCAL);
    expect(o).toMatchObject({ pnr: '4361365838', trainNumber: '18638', from: 'SMVB', to: 'HTE', doj: '2024-02-13', travelClass: '3A', chartPrepared: true, departure: '' });
    expect(o.passengers[0]).toMatchObject({ bookingStatus: 'GNWL 72', currentStatus: 'GNWL 4', currentKind: 'WL', prediction: '67% Chance' });
  });

  test('seat statuses: bare CNF gets its coach / berth; cancelled; odd values', () => {
    expect(t.seatStatus('CNF', 'S6', 71, 'UB')).toEqual({ text: 'CNF S6 71 UB', kind: 'CNF' });
    expect(t.seatStatus('CAN')).toMatchObject({ kind: 'CAN' });
    expect(t.seatStatus('Can/Mod')).toMatchObject({ kind: 'CAN' });
    expect(t.seatStatus('B2/34/LB')).toMatchObject({ kind: 'CNF' }); // seat without the word CNF
    expect(t.seatStatus('TQWL/12')).toEqual({ text: 'TQWL 12', kind: 'WL' });
    expect(t.seatStatus('')).toEqual({ text: '', kind: 'OTHER' });
  });

  test('dates in every spelling', () => {
    expect(t.isoDate('2026-9-5')).toBe('2026-09-05');
    expect(t.isoDate('05-09-2026')).toBe('2026-09-05');
    expect(t.isoDate('5 Sep 2026')).toBe('2026-09-05');
    expect(t.isoDate('20260905')).toBe('2026-09-05');
    expect(t.isoDate('soon')).toBe('');
  });
});

function load(withKey = true) {
  if (withKey) process.env.RAPIDAPI_KEY = 'test-key'; else delete process.env.RAPIDAPI_KEY;
  let ctrl, axios;
  jest.isolateModules(() => { axios = require('axios'); ctrl = require('../controllers/trainController'); });
  axios.get.mockReset();
  return { ctrl, axios };
}

describe('GET /train/pnr', () => {
  afterEach(() => { delete process.env.RAPIDAPI_KEY; });

  test('found → normalised live status, cached', async () => {
    const { ctrl, axios } = load();
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    axios.get.mockResolvedValue({ data: CAMEL });
    const res = mockRes();
    await ctrl.pnr({ query: { pnr: '4231234567' } }, res);
    expect(axios.get.mock.calls[0][0]).toMatch(/\/api\/v3\/getPNRStatus$/);
    expect(axios.get.mock.calls[0][1].params).toEqual({ pnrNumber: '4231234567' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ source: 'live', trainNumber: '12727', passengers: expect.any(Array) });
    // Only field NAMES are logged (no passenger data).
    expect(log.mock.calls[0].join(' ')).not.toMatch(/B2|4231234567/);
    await ctrl.pnr({ query: { pnr: '4231234567' } }, mockRes());
    expect(axios.get).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  test('unknown PNR (status:false) → 404 with a helpful message, briefly cached', async () => {
    const { ctrl, axios } = load();
    axios.get.mockResolvedValue({ data: { status: false, message: 'PNR Not found.', timestamp: 1 } });
    const res = mockRes();
    await ctrl.pnr({ query: { pnr: '4231234560' } }, res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ notFound: true });
    expect(res.body.error).toMatch(/PNR not found/);
    const again = mockRes();
    await ctrl.pnr({ query: { pnr: '4231234560' } }, again);
    expect(again.statusCode).toBe(404);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('PascalCase "Error" payload → 404 too', async () => {
    const { ctrl, axios } = load();
    axios.get.mockResolvedValue({ data: { status: true, data: { Pnr: '1111111111', PassengerStatus: null, Error: 'Invalid PNR number.' } } });
    const res = mockRes();
    await ctrl.pnr({ query: { pnr: '1111111111' } }, res);
    expect(res.statusCode).toBe(404);
  });

  test('invalid numbers never reach IRCTC', async () => {
    const { ctrl, axios } = load();
    for (const pnr of ['123', '0123456789', '12345678901', 'abcdefghij']) {
      const res = mockRes();
      await ctrl.pnr({ query: { pnr } }, res);
      expect(res.statusCode).toBe(400);
    }
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('provider failure → 503 honest error', async () => {
    const { ctrl, axios } = load();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    axios.get.mockRejectedValue(Object.assign(new Error('quota'), { response: { status: 429 } }));
    const res = mockRes();
    await ctrl.pnr({ query: { pnr: '4231234567' } }, res);
    spy.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(res.body.passengers).toBeUndefined();
  });

  test('no key (local dev) → labelled mock in the new shape', async () => {
    const { ctrl, axios } = load(false);
    const res = mockRes();
    await ctrl.pnr({ query: { pnr: '4231234567' } }, res);
    expect(axios.get).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ source: 'mock', pnr: '4231234567' });
    expect(res.body.passengers[0].currentKind).toBe('CNF');
  });
});
