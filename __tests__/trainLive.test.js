'use strict';

// Live running status normaliser, against trimmed copies of two REAL IRCTC1
// /api/v1/liveTrainStatus responses (2026-09-24):
//  • 17201 Golconda Express — reached its destination SC
//  • 12727 Godavari Express — running, "Just left" the non-stop point CU
// IRCTC1 sends the train's CURRENT station only as top-level fields (not in
// previous_/upcoming_stations) and puts a code-less placeholder first in
// upcoming_stations — both used to break the app's timeline.

let normLive;
beforeAll(() => {
  jest.isolateModules(() => { ({ normLive } = require('../controllers/trainController')._test); });
});

const stn = (code, name, km, extra = {}) => ({
  station_code: code, station_name: name, distance_from_source: km,
  sta: '', eta: '', std: '', etd: '', platform_number: 0, non_stops: [], ...extra,
});
const ns = (code, name, km) => ({ station_code: code, station_name: name, distance_from_source: km });

const GOLCONDA_AT_DESTINATION = {
  status: true,
  data: {
    train_number: '17201', train_name: 'Golconda Express',
    source: 'GNT', destination: 'SC', at_dstn: true,
    title: 'Train Run Complete', new_message: 'Train has reached destination.',
    status: 'A', delay: 12, ahead_distance_text: 'At station', status_as_of: 'As of 6 hrs 54 mins ago',
    update_time: '2026-09-24 14:40:00 +0530',
    current_station_code: 'SC', current_station_name: "SECUNDERABAD JN'",
    cur_stn_sta: '14:05', cur_stn_std: '14:05', eta: '14:17', etd: '00:00',
    platform_number: 2, distance_from_source: 381, stoppage_number: 24, a_day: 0,
    cur_stn_lat: '17.433487', cur_stn_lng: '78.501821',
    previous_stations: [
      stn('GNT', 'GUNTUR JN', 0, { sta: '06:00', eta: '00:00', std: '06:00', etd: '06:01', platform_number: 3,
        non_stops: [ns('NGNC', 'NEW GUNTUR CABIN', 3)] }),
      stn('CHZ', 'CHARLAPALLI', 370, { sta: '13:04', eta: '13:04', std: '13:05', etd: '13:05', platform_number: -1 }),
      stn('MLY', 'MAULA ALI', 376, { sta: '13:14', eta: '13:14', std: '13:15', etd: '13:15',
        non_stops: [ns('LGD', 'LALLAGUDA', 379)] }),
    ],
    upcoming_stations: [],
  },
};

const GODAVARI_RUNNING = {
  status: true,
  data: {
    train_number: '12727', train_name: 'Godavari SF Express',
    status: 'T', delay: 35, ahead_distance_text: 'Just left', status_as_of: 'As of 3 mins ago',
    current_station_code: 'CU', current_station_name: "CHAGALLU'",
    cur_stn_sta: '20:56', cur_stn_std: '20:56', eta: '21:31', etd: '21:31',
    platform_number: 0, distance_from_source: 215, stoppage_number: 0, a_day: 0,
    previous_stations: [
      stn('RJY', 'RAJAMUNDRY', 201, { sta: '20:33', eta: '21:03', std: '20:35', etd: '21:07', platform_number: 1,
        non_stops: [ns('GVN', 'GODAVARI', 204), ns('KVR', 'KOVVUR', 209), ns('PSDA', 'PASIVEDALA', 212)] }),
    ],
    upcoming_stations: [
      { ...stn('', '', 0), non_stops: [ns('BMGM', 'BRAHMANAGUDEM', 219)] }, // code-less placeholder
      stn('NDD', 'NIDADAVOLU JN', 223, { sta: '21:08', eta: '21:43', std: '21:10', etd: '21:45', platform_number: 2 }),
    ],
  },
};

describe('normLive — real IRCTC1 shapes', () => {
  test('destination reached: the current station (only in top-level fields) becomes the last stop', () => {
    const out = normLive(GOLCONDA_AT_DESTINATION);
    const codes = out.stations.map((s) => s.code);
    expect(codes).toEqual(['GNT', 'NGNC', 'CHZ', 'MLY', 'LGD', 'SC']);
    const sc = out.stations[out.stations.length - 1];
    expect(sc).toMatchObject({
      code: 'SC', name: 'SECUNDERABAD JN', stop: true, hasArrived: true,
      sta: '14:05', eta: '14:17', platform: '2', distance: 381,
    });
    const halts = out.stations.filter((s) => s.stop).map((s) => s.code);
    expect(halts[halts.length - 1]).toBe('SC'); // not the non-stop LGD / the earlier stop MLY
    expect(out.currentStation).toBe('SECUNDERABAD JN'); // trailing "'" stripped
    expect(out.statusText).toBe('Train has reached destination.');
    expect(out.stations[0].distance).toBe(0); // origin 0 km, not null
  });

  test('running train: placeholder skipped, non-stop current point inserted by distance, human status', () => {
    const out = normLive(GODAVARI_RUNNING);
    expect(out.stations.map((s) => s.code)).toEqual(['RJY', 'GVN', 'KVR', 'PSDA', 'CU', 'BMGM', 'NDD']);
    expect(out.stations.every((s) => s.code)).toBe(true); // no empty-code rows
    const cu = out.stations.find((s) => s.code === 'CU');
    expect(cu).toMatchObject({ name: 'CHAGALLU', stop: false, hasArrived: true, distance: 215 });
    expect(out.stations.find((s) => s.code === 'NDD').hasArrived).toBe(false);
    expect(out.statusText).toBe('Just left Chagallu · 35 min late'); // not "T" / "As of 3 mins ago"
    expect(out.statusAsOf).toBe('As of 3 mins ago');
    expect(out.delayMinutes).toBe(35);
  });

  test('train "N kms ahead" of a non-stop station: placed by route order (si_no), station km = position − N', () => {
    // Real 17405 Krishna Express (2026-09-24): current GHATKESAR, "8 kms ahead", top-level
    // distance 723 = the TRAIN's km — the same km as the next stop CHARLAPALLI. Placing by
    // km put Ghatkesar after Charlapalli (a stop the train had not reached).
    const d = {
      data: {
        train_number: '17405', train_name: 'Krishna Express',
        status: 'T', delay: 121, ahead_distance_text: '8 kms ahead', status_as_of: 'As of 12 mins ago',
        current_station_code: 'GT', current_station_name: 'GHATKESAR', si_no: 53,
        cur_stn_sta: '20:06', cur_stn_std: '20:06', eta: '22:07', etd: '22:07',
        platform_number: 0, distance_from_source: 723, stoppage_number: 0,
        previous_stations: [
          stn('BG', 'BHONGIR', 690, { si_no: 50, sta: '19:34', eta: '21:35', std: '19:35', etd: '21:36', platform_number: 1,
            non_stops: [{ ...ns('PGDP', 'PAGIDIPALLI', 699), si_no: 51 }, { ...ns('BN', 'BIBINAGAR', 703), si_no: 52 }] }),
        ],
        upcoming_stations: [
          { ...stn('', '', 0), si_no: 0, non_stops: [] },
          stn('CHZ', 'CHARLAPALLI', 723, { si_no: 54, sta: '20:15', eta: '22:14', std: '20:25', etd: '22:24', platform_number: 2,
            non_stops: [{ ...ns('MLY', 'MAULA ALI', 729), si_no: 55 }] }),
        ],
      },
    };
    const out = normLive(d);
    expect(out.stations.map((s) => s.code)).toEqual(['BG', 'PGDP', 'BN', 'GT', 'CHZ', 'MLY']);
    expect(out.stations.find((s) => s.code === 'GT')).toMatchObject({ distance: 715, stop: false, hasArrived: true, sta: '20:06', eta: '22:07' });
    expect(out.stations.find((s) => s.code === 'CHZ').hasArrived).toBe(false);
    expect(out.statusText).toBe('8 km past Ghatkesar · 121 min late');
  });

  test('current station already listed → not duplicated', () => {
    const d = JSON.parse(JSON.stringify(GODAVARI_RUNNING));
    d.data.current_station_code = 'RJY';
    d.data.current_station_name = 'RAJAMUNDRY';
    const out = normLive(d);
    expect(out.stations.filter((s) => s.code === 'RJY')).toHaveLength(1);
  });

  test('status variants: at a station / on time / "N km to X" / nothing known', () => {
    const base = JSON.parse(JSON.stringify(GODAVARI_RUNNING));
    const at = { ...base.data, ahead_distance_text: 'At station', delay: 0 };
    expect(normLive({ data: at }).statusText).toBe('At Chagallu · On time');
    const toward = { ...base.data, ahead_distance_text: '1 km to Gundratimadugu', delay: 5 };
    expect(normLive({ data: toward }).statusText).toBe('1 km to Gundratimadugu · 5 min late');
    // Real feed (2026-09-24): "5 kms ahead" with current "PRATTIAPADU" → say where it is past.
    const past = { ...base.data, ahead_distance_text: '5 kms ahead', current_station_name: 'PRATTIAPADU', delay: 36 };
    expect(normLive({ data: past }).statusText).toBe('5 km past Prattiapadu · 36 min late');
    const past1 = { ...base.data, ahead_distance_text: '1 km ahead', delay: 0 };
    expect(normLive({ data: past1 }).statusText).toBe('1 km past Chagallu · On time');
    const none = { ...base.data, ahead_distance_text: '', current_station_name: '', current_station_code: '' };
    expect(normLive({ data: none }).statusText).toBe(''); // app then shows its own delay text
  });

  test('empty / odd payloads never throw', () => {
    expect(normLive(null).stations).toEqual([]);
    expect(normLive({ data: {} }).stations).toEqual([]);
  });
});
