'use strict';

/**
 * Train info proxy — "Where is my train" style features for the app.
 *
 * The app NEVER talks to the train data provider directly: it calls our own
 * /api/public/train/* endpoints, which proxy RapidAPI (IRCTC1) server-side. This
 * keeps the RapidAPI key secret, lets us cache aggressively (RapidAPI bills per
 * call), and normalises every provider response into ONE stable shape so the
 * Flutter app is decoupled from the provider (swap providers → only this file
 * changes).
 *
 * No RAPIDAPI_KEY configured (or the upstream call fails) → we return realistic
 * MOCK data with source:'mock', so the whole feature is demoable before you buy an
 * API plan. Add RAPIDAPI_KEY to .env and real live data flows automatically.
 */

const axios = require('axios');

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'irctc1.p.rapidapi.com';
const BASE = `https://${RAPIDAPI_HOST}`;

// ── cache ───────────────────────────────────────────────────────────────────
//
// IRCTC1 is slow: measured on this server, searchTrain ~1.9 s, liveTrainStatus
// ~1.4 s and getLiveStation ~5.4 s. Nothing here can make the provider quicker,
// so the goal is that a reader almost never waits on it:
//
//  1. STALE-WHILE-REVALIDATE — once a value has been fetched, later readers get
//     it instantly. When it goes past its TTL we still answer from the cache and
//     refresh in the background, so the wait lands on nobody.
//  2. SURVIVES A RESTART — the copy is mirrored into Redis. This process has
//     restarted 159 times; every restart used to send the next reader back to
//     the 5-second path.
//  3. WARMED — the busiest stations are fetched on boot and kept fresh.
//
// A stale answer is a train position a couple of minutes old. The alternative is
// a spinner for five seconds, which is worse, and the payload says `stale: true`
// so nothing pretends otherwise.
const _cache = new Map(); // key -> { exp, stale, val }

/** How long past its TTL a value may still be served while it refreshes. */
const STALE_FOR = {
  'pnr:': 60e3,        // a ticket status matters — a short grace only
  'live:': 5 * 60e3,
  'blive:': 5 * 60e3,
  'board:': 10 * 60e3,
  default: 6 * 3600e3, // schedules and searches barely change
};
const staleWindow = (k) => {
  for (const prefix of Object.keys(STALE_FOR)) {
    if (prefix !== 'default' && k.startsWith(prefix)) return STALE_FOR[prefix];
  }
  return STALE_FOR.default;
};

const REDIS_PREFIX = 'train:';

/**
 * The app's own Redis client, but ONLY if the app has already loaded it.
 *
 * `require('../config/redis')` opens a connection as a side effect of loading.
 * Calling it here would give this controller a live socket wherever it is
 * imported — including Jest, where the open handle kept the run from ever
 * finishing. Reading the require cache means we share the server's client when
 * there is one and quietly skip Redis when there is not.
 */
function redisClient() {
  try {
    const mod = require.cache[require.resolve('../config/redis')];
    const client = mod && mod.exports && mod.exports.redisClient;
    return client && client.isReady ? client : null;
  } catch (_) {
    return null;
  }
}

/** Mirror into Redis so a restart does not send the next reader to the slow path. */
function redisPut(k, entry) {
  try {
    const client = redisClient();
    if (!client) return;
    const keepSec = Math.ceil((entry.stale - Date.now()) / 1000);
    if (keepSec > 0) {
      client.set(REDIS_PREFIX + k, JSON.stringify(entry), { EX: keepSec }).catch(() => {});
    }
  } catch (_) { /* the cache is an optimisation; never let it break a request */ }
}

/** Pull one key back from Redis into memory (used to warm after a restart). */
async function redisGet(k) {
  try {
    const client = redisClient();
    if (!client) return null;
    const raw = await client.get(REDIS_PREFIX + k);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || entry.stale <= Date.now()) return null;
    _cache.set(k, entry);
    return entry;
  } catch (_) {
    return null;
  }
}

/** Fresh value, or null. */
function cacheGet(k) {
  const e = _cache.get(k);
  if (!e) return null;
  if (e.exp > Date.now()) return e.val;
  if (e.stale > Date.now()) return null;   // usable, but only via cacheGetStale
  _cache.delete(k);
  return null;
}

/** Past its TTL but still worth answering with while a refresh runs. */
function cacheGetStale(k) {
  const e = _cache.get(k);
  if (e && e.stale > Date.now()) return e.val;
  if (e) _cache.delete(k);
  return null;
}

function cacheSet(k, val, ttlMs) {
  const now = Date.now();
  const entry = { exp: now + ttlMs, stale: now + ttlMs + staleWindow(k), val };
  _cache.set(k, entry);
  redisPut(k, entry);
}

async function rapid(path, params) {
  const r = await axios.get(`${BASE}${path}`, {
    params,
    timeout: 12000,
    headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': RAPIDAPI_HOST },
  });
  return r.data;
}

const num = (v) => (v == null || v === '' || isNaN(+v) ? null : +v);
// Today's date in India (IST = UTC+5:30) as YYYY-MM-DD — IRCTC1 needs a dateOfJourney.
const istToday = (now = Date.now()) => new Date(now + 5.5 * 3600e3).toISOString().slice(0, 10);
const str = (v) => (v == null ? '' : String(v).trim());
const clean = (v) => str(v).replace(/[~']+$/, ''); // IRCTC names sometimes end with "~" or "'"
const titleCase = (v) => str(v).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
// Minutes-from-midnight → "HH:MM" (schedule route uses minute integers). Pass through
// strings that already look like times.
const hhmm = (v) => {
  if (v == null || v === '') return '';
  if (typeof v === 'string' && v.includes(':')) return v;
  const n = +v; if (!isFinite(n)) return String(v);
  const h = Math.floor(n / 60) % 24, m = ((n % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

// ── normalisers: provider JSON → our stable shape ───────────────────────────
function normLive(d) {
  const b = (d && d.data) || d || {};
  const mapStn = (s, arrived, stop) => ({
    code: str(s.station_code || s.stationCode || s.code),
    name: clean(s.station_name || s.stationName || s.name),
    lat: num(s.station_lat || s.latitude || s.lat), lng: num(s.station_lng || s.longitude || s.lng),
    sta: str(s.sta || s.scheduled_arrival || s.arrivalTime),
    eta: str(s.eta || s.expected_arrival),
    std: str(s.std || s.scheduled_departure || s.departureTime),
    etd: str(s.etd || s.expected_departure),
    distance: num(s.distance_from_source ?? s.distance),
    day: s.a_day != null ? (num(s.a_day) || 0) + 1 : (num(s.day || s.dayCount) || 1),
    delayMinutes: num(s.arrival_delay != null ? s.arrival_delay : s.delay) || 0,
    hasArrived: arrived,
    platform: str(s.platform_number || s.platform),
    stop, // true = train halts here; false = passes through (non-stop)
    seq: num(s.si_no), // IRCTC route order (strictly increasing along the run)
  });
  // IRCTC1 splits the route into already-crossed + still-to-come; each halting
  // station carries the non-stop stations that follow it in `non_stops`. We flatten
  // them into one ordered list so the app can show the full run (halts + passes).
  const flatten = (arr, arrived) => {
    const res = [];
    (Array.isArray(arr) ? arr : []).forEach((s) => {
      // upcoming_stations[0] is often a code-less placeholder for the train's current
      // position that only carries the next non-stops — keep those, skip the entry.
      if (str(s.station_code || s.stationCode || s.code)) res.push(mapStn(s, arrived, true));
      (Array.isArray(s.non_stops) ? s.non_stops : []).forEach((ns) => res.push(mapStn(ns, arrived, false)));
    });
    return res;
  };
  const prev = flatten(b.previous_stations, true);
  const up = flatten(b.upcoming_stations, false);
  let stations = [...prev, ...up];
  if (!stations.length) { // fallback for a flat list shape
    const flat = b.stations || b.route || [];
    stations = (Array.isArray(flat) ? flat : []).map((s) => mapStn(s, !!(s.has_arrived || s.hasArrived), s.stop !== false));
  }
  // The station the train is at / just passed is NOT in previous_ or upcoming_stations;
  // IRCTC1 sends it as top-level fields. Insert it by distance so the timeline shows it
  // (e.g. the destination once reached, or a non-stop point it "just left").
  const curCode = str(b.current_station_code).toUpperCase();
  if (curCode && !stations.some((x) => x.code.toUpperCase() === curCode)) {
    // Top-level distance_from_source is the TRAIN's position ("8 kms ahead" of the
    // station), not the station's own km — take the ahead distance off.
    const aheadKm = (() => { const m = str(b.ahead_distance_text).match(/^(\d+(?:\.\d+)?)\s*kms?\s+ahead$/i); return m ? +m[1] : 0; })();
    const posKm = num(b.distance_from_source);
    const cur = mapStn({
      station_code: curCode, station_name: b.current_station_name, si_no: b.si_no,
      station_lat: b.cur_stn_lat, station_lng: b.cur_stn_lng,
      sta: b.cur_stn_sta, std: b.cur_stn_std, eta: b.eta, etd: b.etd,
      distance_from_source: posKm == null ? null : Math.max(0, Math.round(posKm - aheadKm)), a_day: b.a_day,
      arrival_delay: b.delay, platform_number: b.platform_number,
    }, true, num(b.stoppage_number) > 0);
    // Place it by IRCTC's route order (si_no); fall back to km only when there is none.
    let at;
    if (cur.seq != null && stations.some((x) => x.seq != null)) at = stations.findIndex((x) => x.seq != null && x.seq > cur.seq);
    else at = cur.distance == null ? -1 : stations.findIndex((x) => x.distance != null && x.distance > cur.distance);
    if (at < 0) at = stations.length;
    stations.splice(at, 0, cur);
  }
  // Status line: IRCTC's own message when present ("Train has reached destination."),
  // else "Just left Chagallu · 35 min late" built from the position fields — never the
  // raw one-letter status code or the "As of …" timestamp (that is shown separately).
  let statusText = str(b.new_message || b.title);
  if (!statusText) {
    const where = titleCase(clean(b.current_station_name));
    const ahead = str(b.ahead_distance_text);
    let pos = '';
    const past = ahead.match(/^(\d+(?:\.\d+)?)\s*kms?\s+ahead$/i); // "5 kms ahead" = 5 km past the current station
    if (/^at station$/i.test(ahead) && where) pos = `At ${where}`;
    else if (/^just left$/i.test(ahead) && where) pos = `Just left ${where}`;
    else if (past && where) pos = `${past[1]} km past ${where}`;
    else if (ahead && !/^(at station|just left)$/i.test(ahead)) pos = ahead;
    else if (where) pos = `Near ${where}`;
    const delay = num(b.delay) || 0;
    if (pos) statusText = `${pos} · ${delay > 0 ? `${delay} min late` : 'On time'}`;
  }
  const curLat = num(b.cur_stn_lat), curLng = num(b.cur_stn_lng);
  return {
    train: { number: str(b.train_number || b.trainNo), name: clean(b.train_name || b.trainName) },
    currentStation: clean(b.current_station_name || b.currentStation),
    statusText,
    ahead: str(b.ahead_distance_text),               // e.g. "1 km to Gundratimadugu"
    statusAsOf: str(b.status_as_of),                  // e.g. "As of 6 hrs 23 mins ago"
    delayMinutes: num(b.delay) || 0,
    lastUpdated: str(b.update_time || b.status_as_of || b.last_update || b.updated_time),
    // The run's first / last station (IRCTC1 top-level) — used by the station board.
    originCode: str(b.source).toUpperCase(), originName: titleCase(clean(b.source_stn_name)),
    destCode: str(b.destination).toUpperCase(), destName: titleCase(clean(b.dest_stn_name)),
    currentCode: curCode,
    stations,
    position: (curLat && curLng)
      ? { lat: curLat, lng: curLng, betweenFrom: str(b.current_station_code), betweenTo: '', progress: 0 }
      : null,
  };
}

// ── PNR ──────────────────────────────────────────────────────────────────────
// IRCTC1 v3 getPNRStatus answers HTTP 200 {status:false, message:"PNR Not found."} for an
// unknown PNR (verified 2026-09-25). For a found PNR two shapes are in circulation —
// IRCTC's own camelCase (passengerList / bookingStatusDetails / chartStatus text) and a
// PascalCase one (PassengerStatus / BookingStatus / ChartPrepared bool) — so read both.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n) => String(n).padStart(2, '0');
// "Sep 25, 2026 5:40:00 PM" / "25-09-2026" / "25-9-2026" / "2026-09-25" / "20260925" → "2026-09-25" ('' if unknown).
function isoDate(v) {
  const t = str(v);
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;
  m = t.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad2(MONTHS[m[1].toLowerCase()])}-${pad2(m[2])}`;
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad2(MONTHS[m[2].toLowerCase()])}-${pad2(m[1])}`;
  m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}
// "5:40:00 PM" inside a date-time, or "17:40" → "17:40" ('' if none).
function clockOf(v) {
  const t = str(v);
  const m = t.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?/i);
  if (!m) return '';
  let h = +m[1];
  if (m[3]) { const pm = m[3].toUpperCase() === 'PM'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  return h < 24 ? `${pad2(h)}:${m[2]}` : '';
}
const dayTime = (v) => { const c = clockOf(v); return c === '00:00' ? '' : c; };
// A seat status in any IRCTC spelling → { text, kind } for people:
// "CNF/B2/34/LB" → "CNF B2 34 LB"; "RLWL/-/16/GN" → "RLWL 16"; "GNWL 72" → "GNWL 72";
// kind = CNF | RAC | WL | CAN | OTHER.
function seatStatus(raw, coach, berth, berthCode) {
  let t = str(raw).replace(/\s+/g, ' ');
  const parts = t.split(/[/,\s]+/).map((x) => x.trim()).filter((x) => x && x !== '-' && x !== '0');
  // A trailing quota code ("GN", "TQ", "LD") after a waitlist number is noise.
  if (parts.length > 2 && /^(GN|TQ|PT|LD|SS|HP|DF|FT|YU|PH|RS|CK|OS)$/i.test(parts[parts.length - 1]) && /WL|RAC/i.test(parts[0])) parts.pop();
  t = parts.join(' ');
  const U = t.toUpperCase();
  let kind = 'OTHER';
  if (/\bCAN\b|CANCEL|\bMOD\b/.test(U)) kind = 'CAN';
  else if (/\bRAC\b|^RAC/.test(U)) kind = 'RAC';
  else if (/WL\b|WL\s*\d|W\/L|WAIT/.test(U)) kind = 'WL';
  else if (/^CNF|CONFIRM|^[A-Z]{1,2}\d{1,2}\s+\d+/.test(U)) kind = 'CNF';
  // Only a bare "CNF" came: add the coach/berth given separately.
  if (kind === 'CNF' && parts.length === 1) {
    const extra = [str(coach), num(berth) ? String(num(berth)) : '', str(berthCode)].filter(Boolean);
    if (extra.length) t = ['CNF', ...extra].join(' ');
  }
  return { text: t, kind };
}

function normPnr(d) {
  const b = (d && d.data) || d || {};
  const g = (...keys) => { for (const k of keys) { const v = b[k]; if (v != null && v !== '') return v; } return ''; };
  const pax = [b.passengerList, b.PassengerStatus, b.passengers, b.passengerDetails].find((x) => Array.isArray(x)) || [];
  const chartRaw = g('chartStatus', 'chart_status', 'ChartStatus');
  const chartPrepared = typeof b.ChartPrepared === 'boolean' ? b.ChartPrepared
    : typeof b.chartPrepared === 'boolean' ? b.chartPrepared
    : /prepared/i.test(str(chartRaw)) && !/not/i.test(str(chartRaw));
  const passengers = pax.map((p, i) => {
    const booking = seatStatus(p.bookingStatusDetails || p.BookingStatus || p.bookingStatus || p.booking_status,
      p.bookingCoachId || p.BookingCoachId, p.bookingBerthNo || p.BookingBerthNo, p.bookingBerthCode || p.BookingBerthCode);
    const current = seatStatus(p.currentStatusDetails || p.CurrentStatus || p.currentStatus || p.current_status || booking.text,
      p.currentCoachId || p.CurrentCoachId || p.Coach, p.currentBerthNo || p.CurrentBerthNo || p.Berth, p.currentBerthCode || p.CurrentBerthCode);
    return {
      no: num(p.passengerSerialNumber ?? p.Number ?? p.no) || i + 1,
      bookingStatus: booking.text, bookingKind: booking.kind,
      currentStatus: current.text, currentKind: current.kind,
      coach: str(p.currentCoachId || p.CurrentCoachId || p.Coach || p.coach),
      berth: num(p.currentBerthNo ?? p.CurrentBerthNo ?? p.Berth) ? String(num(p.currentBerthNo ?? p.CurrentBerthNo ?? p.Berth)) : '',
      prediction: str(p.Prediction || p.prediction || (p.PredictionPercentage ? `${p.PredictionPercentage}% chance` : '') || (p.predictionPercentage ? `${p.predictionPercentage}% chance` : '')),
    };
  });
  const dojRaw = g('dateOfJourney', 'Doj', 'doj', 'SourceDoj', 'journeyDate');
  const fare = num(g('ticketFare', 'bookingFare', 'TicketFare', 'fare'));
  const upper = (v) => str(v).toUpperCase();
  const out = {
    pnr: str(g('pnrNumber', 'Pnr', 'pnr')),
    trainNumber: str(g('trainNumber', 'TrainNo', 'train_number', 'trainNo')),
    trainName: titleCase(clean(g('trainName', 'TrainName', 'train_name'))),
    // Journey ends: where the ticket starts / ends (boarding may differ from the start).
    from: upper(g('sourceStation', 'From', 'source', 'fromStation')),
    to: upper(g('destinationStation', 'reservationUpto', 'To', 'ReservationUpto', 'destination', 'toStation')),
    boardingPoint: upper(g('boardingPoint', 'BoardingPoint')),
    fromName: titleCase(clean(g('sourceStationName', 'SourceName', 'FromName', 'BoardingStationName'))),
    toName: titleCase(clean(g('destinationStationName', 'ReservationUptoName', 'ToName'))),
    doj: isoDate(dojRaw),
    dojText: str(dojRaw),
    // Times ride inside IRCTC's date-times ("Sep 25, 2026 5:40:00 PM"); a bare midnight is a date only.
    departure: clockOf(g('departureTime', 'DepartureTime')) || dayTime(dojRaw),
    arrival: clockOf(g('arrivalTime', 'ArrivalTime')) || dayTime(g('arrivalDate', 'DestinationDoj')),
    arrivalDate: isoDate(g('arrivalDate', 'DestinationDoj')),
    travelClass: str(g('journeyClass', 'Class', 'class', 'travelClass')),
    quota: str(g('quota', 'Quota')),
    chartPrepared,
    chartStatus: str(chartRaw) || (chartPrepared ? 'Chart Prepared' : 'Chart Not Prepared'),
    trainCancelled: b.TrainCancelledFlag === true || /cancel/i.test(str(g('trainCancelStatus'))),
    bookingDate: isoDate(g('bookingDate', 'BookingDate')),
    fare,
    passengers,
  };
  // Kept for older app builds (they read these names).
  out.doj = out.doj || str(dojRaw);
  return out;
}

let _pnrShapeLogged = false;

function normSchedule(d) {
  const b = (d && d.data) || d || {};
  const stns = b.route || b.stations || [];
  return {
    train: { number: str(b.trainNumber || b.train_number || b.trainNo), name: clean(b.trainName || b.train_name) },
    stations: (Array.isArray(stns) ? stns : []).map((s) => ({
      code: str(s.station_code || s.code), name: clean(s.station_name || s.name),
      sta: hhmm(s.arrive != null ? s.arrive : s.sta),
      std: hhmm(s.depart != null ? s.depart : (s.std_min != null ? s.std_min : s.std)),
      day: num(s.day) || 1, distance: num(s.distance), platform: str(s.platform),
    })),
  };
}

function normBetween(d) {
  const b = (d && d.data) || d || [];
  const list = Array.isArray(b) ? b : (b.trains || []);
  return {
    trains: list.map((t) => {
      const days = Array.isArray(t.run_days) ? t.run_days.map(str).filter(Boolean) : null;
      const fromDay = num(t.from_day), toDay = num(t.to_day);
      return {
        number: str(t.train_number || t.trainNo), name: clean(t.train_name || t.trainName),
        // Codes of the stations the train actually uses (may be a sibling station of the
        // one searched, e.g. HYB/KCG for SC) + their names for display.
        from: str(t.from || t.from_station_code || t.fromStationCode).toUpperCase(),
        to: str(t.to || t.to_station_code || t.toStationCode).toUpperCase(),
        fromName: clean(t.from_station_name || t.fromStationName),
        toName: clean(t.to_station_name || t.toStationName),
        departure: str(t.from_std || t.departureTime), arrival: str(t.to_sta || t.to_std || t.arrivalTime),
        // IRCTC sometimes leaves minutes unpadded ("5:5" = 5 h 05 m) → "5:05".
        duration: str(t.duration).replace(/^(\d+):(\d)$/, '$1:0$2'),
        runsOn: days ? (days.length >= 7 ? 'Daily' : days.join(',')) : str(t.run_days || t.runningDays),
        // Days after departure that the train reaches the destination (0 = same day, 1 = "+1").
        arrivalDayOffset: fromDay != null && toDay != null ? Math.max(0, toDay - fromDay) : null,
        classes: Array.isArray(t.class_type) ? t.class_type.map(str).filter(Boolean) : [],
        trainType: str(t.train_type),
      };
    }),
  };
}

function normSearch(d) {
  const b = (d && d.data) || d || [];
  const list = Array.isArray(b) ? b : (b.trains || []);
  return {
    trains: list.map((t) => ({
      number: str(t.train_number || t.trainNo), name: clean(t.train_name || t.trainName),
      from: str(t.src_stn_code || t.train_src || t.from), to: str(t.dstn_stn_code || t.train_dstn || t.to),
    })),
  };
}

// ── MOCK data (used when no key / upstream fails), so the demo always works ──
const MOCK_ROUTE = [
  { code: 'SC', name: 'Secunderabad Jn', lat: 17.4344, lng: 78.5013, sta: '', std: '06:50', distance: 0, day: 1 },
  { code: 'KZJ', name: 'Kazipet Jn', lat: 17.9640, lng: 79.5000, sta: '08:18', std: '08:20', distance: 132, day: 1 },
  { code: 'BPQ', name: 'Balharshah Jn', lat: 19.8300, lng: 79.3600, sta: '10:35', std: '10:45', distance: 336, day: 1 },
  { code: 'NGP', name: 'Nagpur Jn', lat: 21.1520, lng: 79.0880, sta: '13:05', std: '13:15', distance: 573, day: 1 },
  { code: 'BPL', name: 'Bhopal Jn', lat: 23.2599, lng: 77.4126, sta: '18:40', std: '18:45', distance: 963, day: 1 },
  { code: 'JHS', name: 'Jhansi Jn', lat: 25.4484, lng: 78.5685, sta: '22:28', std: '22:33', distance: 1256, day: 1 },
  { code: 'AGC', name: 'Agra Cantt', lat: 27.1591, lng: 78.0170, sta: '01:05', std: '01:10', distance: 1471, day: 2 },
  { code: 'NDLS', name: 'New Delhi', lat: 28.6431, lng: 77.2197, sta: '05:35', std: '', distance: 1662, day: 2 },
];
function mockLive() {
  const curIdx = 3; // just departed Nagpur
  const stations = MOCK_ROUTE.map((s, i) => ({
    ...s, lat: s.lat, lng: s.lng, eta: '', etd: '',
    delayMinutes: i >= curIdx ? 15 : 0, hasArrived: i <= curIdx, platform: String((i % 6) + 1), stop: true,
  }));
  // A couple of non-stop (pass-through) stations, so the demo shows the grey band.
  const ns = (code, name, distance, arrived) => ({ code, name, lat: null, lng: null, sta: '', eta: '', std: '', etd: '', distance, day: 1, delayMinutes: 0, hasArrived: arrived, platform: '', stop: false });
  stations.splice(1, 0, ns('LPI', 'Lingampalli', 24, true), ns('MED', 'Medchal', 40, true));
  stations.splice(6, 0, ns('SEGM', 'Sengaon', 410, false), ns('MJRI', 'Majri Junction', 500, false));
  const a = MOCK_ROUTE[curIdx], b = MOCK_ROUTE[curIdx + 1];
  return {
    source: 'mock',
    train: { number: '12723', name: 'Telangana Express' },
    currentStation: a.name,
    statusText: `Departed ${a.name}, running 15 min late`,
    delayMinutes: 15,
    lastUpdated: new Date().toISOString(),
    stations,
    position: { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2, betweenFrom: a.code, betweenTo: b.code, progress: 0.5 },
  };
}
function mockPnr(pnr) {
  const doj = istToday(Date.now() + 2 * 864e5);
  return {
    source: 'mock', pnr: str(pnr) || '2451234567', trainNumber: '12723', trainName: 'Telangana Express',
    from: 'SC', to: 'NDLS', boardingPoint: 'SC', fromName: 'Secunderabad Jn', toName: 'New Delhi',
    doj, dojText: doj, departure: '06:50', arrival: '', travelClass: '3A', quota: 'GN',
    chartPrepared: false, chartStatus: 'Chart Not Prepared', trainCancelled: false, bookingDate: '', fare: 1835,
    passengers: [
      { no: 1, bookingStatus: 'CNF B2 34 LB', bookingKind: 'CNF', currentStatus: 'CNF B2 34 LB', currentKind: 'CNF', coach: 'B2', berth: '34', prediction: '' },
      { no: 2, bookingStatus: 'GNWL 15', bookingKind: 'WL', currentStatus: 'RAC 4', currentKind: 'RAC', coach: '', berth: '', prediction: '' },
    ],
  };
}
function mockSchedule() {
  return {
    source: 'mock', train: { number: '12723', name: 'Telangana Express' },
    stations: MOCK_ROUTE.map((s) => ({ code: s.code, name: s.name, sta: s.sta, std: s.std, day: s.day, distance: s.distance, platform: '' })),
  };
}
function mockBetween(from, to) {
  return {
    source: 'mock',
    trains: [
      { number: '12723', name: 'Telangana Express', from: str(from) || 'SC', to: str(to) || 'NDLS', departure: '06:50', arrival: '05:35', duration: '22:45', runsOn: 'Daily' },
      { number: '12285', name: 'Duronto Express', from: str(from) || 'SC', to: str(to) || 'NDLS', departure: '11:00', arrival: '07:40', duration: '20:40', runsOn: 'Mon,Wed,Fri' },
      { number: '22691', name: 'Rajdhani Express', from: str(from) || 'SC', to: str(to) || 'NDLS', departure: '12:45', arrival: '10:10', duration: '21:25', runsOn: 'Daily' },
    ],
  };
}
function mockSearch(q) {
  return { source: 'mock', trains: [{ number: '12723', name: 'Telangana Express', from: 'SC', to: 'NDLS' }, { number: '12285', name: 'Secunderabad Duronto', from: 'SC', to: 'NDLS' }] };
}

// helper: try upstream, fall back to mock on any problem
// ── all days: every train on a route, whatever day it runs ──────────────────
// IRCTC1 has no "all trains between stations" call: v3 insists on a boarding date and
// returns only the trains leaving the from-station on that date (v1 = 404, v2 = empty).
// So for the app's "All days" view we ask for the next 7 boarding dates and merge by
// train number — the app then greys the trains not running today (Where-is-my-Train
// style). A route's merged list is cached for 7 days and shared by every user
// (timetables rarely change); concurrent first requests share one set of calls.
const ALL_DAYS_TTL = 7 * 24 * 3600e3;
const ALL_DAYS_RETRY_TTL = 10 * 60e3; // some day failed → keep it only briefly, then retry
const _allDaysInflight = new Map();

async function fetchBetweenDay(from, to, date) {
  const key = `btw:${from}:${to}:${date}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const out = normBetween(await rapid('/api/v3/trainBetweenStations', { fromStationCode: from, toStationCode: to, dateOfJourney: date }));
  out.source = 'live';
  cacheSet(key, out, 3600e3); // the single-date view reuses these
  return out;
}

async function fetchBetweenAllDays(from, to) {
  const now = Date.now();
  const dates = Array.from({ length: 7 }, (_, i) => istToday(now + i * 864e5));
  const settled = await Promise.allSettled(dates.map((d) => fetchBetweenDay(from, to, d)));
  const ok = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw settled[0].reason; // nothing loaded → honest "unavailable"
  const byNumber = new Map();
  for (const day of ok) for (const t of day.trains || []) if (!byNumber.has(t.number)) byNumber.set(t.number, t);
  const trains = [...byNumber.values()].sort((a, b) => str(a.departure).localeCompare(str(b.departure)));
  return { source: 'live', allDays: true, incomplete: ok.length < dates.length, days: ok.length, trains };
}

async function serveAllDays(res, from, to) {
  if (!RAPIDAPI_KEY) return res.json({ ...mockBetween(from, to), allDays: true, incomplete: false });
  const key = `btwall:${from}:${to}`;
  const hit = cacheGet(key);
  if (hit) return res.json(hit);
  let pending = _allDaysInflight.get(key);
  if (!pending) {
    pending = fetchBetweenAllDays(from, to).finally(() => _allDaysInflight.delete(key));
    _allDaysInflight.set(key, pending);
  }
  try {
    const out = await pending;
    cacheSet(key, out, out.incomplete ? ALL_DAYS_RETRY_TTL : ALL_DAYS_TTL);
    return res.json(out);
  } catch (e) {
    const status = (e && e.response && e.response.status) || (e && e.message);
    console.error('train upstream failed:', status);
    return res.status(503).json({
      source: 'unavailable', note: 'live_unavailable', upstreamStatus: status,
      error: 'Live train data is temporarily unavailable. Please try again in a few minutes.',
    });
  }
}

/** One refresh per key at a time, however many readers arrive together. */
const _refreshing = new Map();

function refreshInBackground(cacheKey, { ttlMs, path, params, normalize }) {
  if (_refreshing.has(cacheKey)) return _refreshing.get(cacheKey);
  const p = rapid(path, params)
    .then((raw) => {
      const out = normalize(raw);
      out.source = 'live';
      cacheSet(cacheKey, out, ttlMs);
      return out;
    })
    .catch((e) => {
      // Keep serving the value we have; the next reader triggers another try.
      console.error('train refresh failed (serving cached):', (e.response && e.response.status) || e.message);
      return null;
    })
    .finally(() => _refreshing.delete(cacheKey));
  _refreshing.set(cacheKey, p);
  return p;
}

async function serve(res, { cacheKey, ttlMs, path, params, normalize, mock }) {
  try {
    const hit = cacheGet(cacheKey);
    if (hit) return res.json(hit);

    // Nothing in memory — a restart may have wiped it, so look in Redis before
    // paying for the slow upstream call.
    if (!_cache.has(cacheKey)) await redisGet(cacheKey);
    const fresh = cacheGet(cacheKey);
    if (fresh) return res.json(fresh);

    // Past its TTL but still usable: answer NOW and refresh behind the reader.
    const stale = cacheGetStale(cacheKey);
    if (stale && RAPIDAPI_KEY) {
      refreshInBackground(cacheKey, { ttlMs, path, params, normalize });
      return res.json({ ...stale, stale: true });
    }

    if (!RAPIDAPI_KEY) { const m = mock(); cacheSet(cacheKey, m, ttlMs); return res.json(m); }
    const raw = await rapid(path, params);
    const out = normalize(raw);
    out.source = 'live';
    cacheSet(cacheKey, out, ttlMs);
    return res.json(out);
  } catch (e) {
    const status = (e.response && e.response.status) || e.message;
    console.error('train upstream failed:', status);
    // Anything we hold beats an error screen when the provider is down.
    const rescue = cacheGetStale(cacheKey);
    if (rescue) return res.json({ ...rescue, stale: true });
    // A key IS configured but the provider failed (quota 429, outage, bad params). Mock
    // data here would show made-up trains / PNR status to real users, so return an honest
    // error instead. (Mock data is only for local dev without a key — see above.)
    return res.status(503).json({
      source: 'unavailable', note: 'live_unavailable', upstreamStatus: status,
      error: 'Live train data is temporarily unavailable. Please try again in a few minutes.',
    });
  }
}

// ── endpoints ───────────────────────────────────────────────────────────────
// GET /api/public/train/search?q=raj
exports.search = (req, res) => {
  const q = str(req.query.q);
  if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 characters.' });
  return serve(res, { cacheKey: 'search:' + q.toLowerCase(), ttlMs: 6 * 3600e3, path: '/api/v1/searchTrain', params: { query: q }, normalize: normSearch, mock: () => mockSearch(q) });
};

// GET /api/public/train/live?train=12723&day=1
exports.live = (req, res) => {
  const train = str(req.query.train);
  if (!/^\d{4,6}$/.test(train)) return res.status(400).json({ error: 'Enter a valid train number.' });
  // startDay: 0 = train departed source TODAY (default), 1 = yesterday, 2 = 2 days ago.
  const day = /^[0-4]$/.test(str(req.query.day)) ? str(req.query.day) : '0';
  return serve(res, { cacheKey: `live:${train}:${day}`, ttlMs: 60e3, path: '/api/v1/liveTrainStatus', params: { trainNo: train, startDay: day }, normalize: normLive, mock: mockLive });
};

// GET /api/public/train/pnr?pnr=2451234567
const PNR_TTL = 5 * 60e3;
const PNR_NOT_FOUND_TTL = 2 * 60e3;
const PNR_NOT_FOUND = 'PNR not found. Check the 10-digit number on your ticket — IRCTC removes a PNR some days after the journey.';
exports.pnr = async (req, res) => {
  const pnr = str(req.query.pnr);
  if (!/^[1-9]\d{9}$/.test(pnr)) return res.status(400).json({ error: 'Enter a valid 10-digit PNR.' });
  const key = 'pnr:' + pnr;
  const hit = cacheGet(key);
  if (hit) return hit.notFound ? res.status(404).json(hit) : res.json(hit);
  if (!RAPIDAPI_KEY) { const m = mockPnr(pnr); cacheSet(key, m, PNR_TTL); return res.json(m); }
  try {
    const raw = await rapid('/api/v3/getPNRStatus', { pnrNumber: pnr });
    const out = normPnr(raw);
    const found = raw && raw.status !== false && !(raw.data && raw.data.Error) && (out.trainNumber || out.passengers.length);
    if (!found) {
      const nf = { source: 'live', notFound: true, pnr, error: PNR_NOT_FOUND };
      cacheSet(key, nf, PNR_NOT_FOUND_TTL);
      return res.status(404).json(nf);
    }
    if (!_pnrShapeLogged) { // field NAMES only (no personal data) — confirms which shape IRCTC sends
      _pnrShapeLogged = true;
      const b = (raw && raw.data) || {};
      const p0 = (b.passengerList || b.PassengerStatus || [])[0] || {};
      console.log('pnr shape:', Object.keys(b).join(','), '| passenger:', Object.keys(p0).join(','));
    }
    out.pnr = out.pnr || pnr;
    out.source = 'live';
    cacheSet(key, out, PNR_TTL);
    return res.json(out);
  } catch (e) {
    const status = (e.response && e.response.status) || e.message;
    console.error('train upstream failed:', status);
    // A ticket we already looked up beats an error screen — but only briefly
    // (see STALE_FOR['pnr:']), because a seat status really can change.
    const rescue = cacheGetStale(key);
    if (rescue) return res.json({ ...rescue, stale: true });
    return res.status(503).json({
      source: 'unavailable', note: 'live_unavailable', upstreamStatus: status,
      error: 'Live train data is temporarily unavailable. Please try again in a few minutes.',
    });
  }
};

// GET /api/public/train/schedule?train=12723
exports.schedule = (req, res) => {
  const train = str(req.query.train);
  if (!/^\d{4,6}$/.test(train)) return res.status(400).json({ error: 'Enter a valid train number.' });
  return serve(res, { cacheKey: 'sch:' + train, ttlMs: 24 * 3600e3, path: '/api/v1/getTrainSchedule', params: { trainNo: train }, normalize: normSchedule, mock: mockSchedule });
};

// GET /api/public/train/between?from=SC&to=NDLS&date=2026-09-10
exports.between = (req, res) => {
  const from = str(req.query.from).toUpperCase(), to = str(req.query.to).toUpperCase();
  if (!from || !to) return res.status(400).json({ error: 'Enter both station codes.' });
  const q = str(req.query.date);
  if (q.toLowerCase() === 'all') return serveAllDays(res, from, to); // every train, any day
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : istToday();
  return serve(res, { cacheKey: `btw:${from}:${to}:${date}`, ttlMs: 3600e3, path: '/api/v3/trainBetweenStations', params: { fromStationCode: from, toStationCode: to, dateOfJourney: date }, normalize: normBetween, mock: () => mockBetween(from, to) });
};

// ── station departure board ─────────────────────────────────────────────────
// IRCTC1 /api/v3/getLiveStation lists the trains due at a station in the next N hours
// (verified 2026-09-25, KMT): number, name, type, run days (at the ORIGIN) and times
// counted from the run's start day — "34:34" = the day after the train left its origin,
// 10:34. It has no origin/destination, delay or platform, so each train's own live
// status (liveTrainStatus, loaded lazily by the app for the cards on screen) adds them.
const BOARD_HOURS = [2, 4, 8, 12];
const BOARD_TTL = 5 * 60e3;            // the station list itself
const BOARD_LIVE_TTL = 3 * 60e3;       // one train's live status, as used by boards
const TRAIN_INFO_TTL = 7 * 24 * 3600e3; // a train's origin / destination
const BOARD_RECENT_MS = 150 * 60e3;    // keep showing a train this long after its time (late trains)
const BOARD_LIVE_MAX = 12;             // trains per live request
const IST_MS = 5.5 * 3600e3;
const _boardSeen = new Map();          // station → Map(key → train) of recent board entries
const _liveInflight = new Map();

// "HH:MM" (HH may be ≥ 24) → { day, min } — day = days after the run started.
function relTime(v) {
  const m = str(v).match(/^(\d{1,3}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mm = +m[2];
  return { day: Math.floor(h / 24), min: (h % 24) * 60 + mm };
}
const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const istDateOf = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istMidnight = (date) => Date.parse(`${date}T00:00:00Z`) - IST_MS;

function normBoard(d, now = Date.now()) {
  const list = Array.isArray(d && d.data) ? d.data : [];
  const today = istDateOf(now);
  const nowMin = Math.floor((now - istMidnight(today)) / 60e3);
  const trains = [];
  for (const t of list) {
    const number = str(t.trainNumber || t.train_number);
    if (!/^\d{4,6}$/.test(number)) continue;
    const arr = relTime(t.arrivalTime), dep = relTime(t.departureTime);
    const ref = arr || dep;
    if (!ref) continue;
    // IRCTC looks forward from now: a time "behind" now belongs to tomorrow — unless it
    // is only a little behind (a train listed right at its time).
    let delta = (ref.min - nowMin + 1440) % 1440;
    if (delta > 20 * 60) delta -= 1440;
    const shift = nowMin + delta >= 1440 ? 1 : (nowMin + delta < 0 ? -1 : 0); // at-date vs today
    const atDate = istDateOf(istMidnight(today) + shift * 864e5 + 12 * 3600e3);
    const days = t.runDays && typeof t.runDays === 'object'
      ? ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].filter((k) => t.runDays[k]).map((k) => k[0].toUpperCase() + k.slice(1))
      : [];
    trains.push({
      number,
      name: clean(t.trainName || t.train_name),
      type: titleCase(t.trainType),
      runsOn: days.length >= 7 ? 'Daily' : days.join(','),
      arrival: arr ? hm(arr.min) : '', departure: dep ? hm(dep.min) : '',
      at: istMidnight(atDate) + ref.min * 60e3, // scheduled time here (epoch ms)
      // liveTrainStatus startDay for this run (0 = started today). < 0 → not started yet.
      startDay: ref.day - shift,
    });
  }
  trains.sort((a, b) => a.at - b.at);
  return { trains };
}

// Late trains fall out of IRCTC's forward-looking window at their scheduled time, but
// people on the platform still wait for them — remember recent entries per station.
function boardRemember(code, trains, now) {
  let seen = _boardSeen.get(code);
  if (!seen) { seen = new Map(); _boardSeen.set(code, seen); }
  for (const t of trains) seen.set(`${t.number}@${t.at}`, t);
  for (const [k, t] of seen) if (t.at < now - BOARD_RECENT_MS) seen.delete(k);
}
function boardWithRecent(code, trains, now) {
  const keys = new Set(trains.map((t) => `${t.number}@${t.at}`));
  const recent = [];
  for (const [k, t] of _boardSeen.get(code) || []) {
    if (!keys.has(k) && t.at < now && t.at >= now - BOARD_RECENT_MS) recent.push({ ...t, past: true });
  }
  return [...recent, ...trains].sort((a, b) => a.at - b.at);
}

/** Refresh one station board out of band; one at a time per station. */
const _boardRefreshing = new Set();
function refreshBoard(code, hours) {
  const key = `board:${code}:${hours}`;
  if (_boardRefreshing.has(key) || !RAPIDAPI_KEY) return;
  _boardRefreshing.add(key);
  rapid('/api/v3/getLiveStation', { fromStationCode: code, hours: String(hours) })
    .then((raw) => {
      const now = Date.now();
      const board = normBoard(raw, now);
      cacheSet(key, board, BOARD_TTL);
      boardRemember(code, board.trains, now);
    })
    .catch((e) => console.error('board refresh failed (serving cached):', (e.response && e.response.status) || e.message))
    .finally(() => _boardRefreshing.delete(key));
}

// One train's live status for a board: shared with the live page's cache (`live:`),
// kept a little longer for boards, and fetched once even when many users ask together.
async function boardLive(number, day) {
  const key = `live:${number}:${day}`, bkey = `blive:${number}:${day}`;
  const hit = cacheGet(key) || cacheGet(bkey);
  if (hit) return hit;
  // A position a few minutes old, handed over at once, beats a 1.4 s wait per
  // train on a board that lists a dozen of them.
  const stale = cacheGetStale(key) || cacheGetStale(bkey);
  let p = _liveInflight.get(bkey);
  if (!p) {
    const once = () => rapid('/api/v1/liveTrainStatus', { trainNo: number, startDay: String(day) });
    // IRCTC1 now and then takes > 12 s on one call and is fine right after — try once more
    // (not on quota / bad-request errors, a retry can't help those).
    p = once()
      .catch((e) => {
        const st = e && e.response && e.response.status;
        if (st === 429 || st === 400 || st === 403) throw e;
        return once();
      })
      .then((raw) => {
        const out = normLive(raw);
        out.source = 'live';
        cacheSet(key, out, 60e3);
        cacheSet(bkey, out, BOARD_LIVE_TTL);
        if (out.originCode) {
          cacheSet(`tinfo:${number}`, { originCode: out.originCode, originName: out.originName, destCode: out.destCode, destName: out.destName }, TRAIN_INFO_TTL);
        }
        return out;
      })
      .finally(() => _liveInflight.delete(bkey));
    _liveInflight.set(bkey, p);
  }
  if (stale) {
    p.catch(() => {});      // the refresh keeps running for the next reader
    return { ...stale, stale: true };
  }
  return p;
}

const minsOf = (t) => { const m = str(t).match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : null; };

// What a board card needs from a train's live status, for station `code`:
// state upcoming | at | departed | unknown, expected times, delay, platform.
function boardView(norm, code) {
  const base = { originCode: norm.originCode || '', originName: norm.originName || '', destCode: norm.destCode || '', destName: norm.destName || '' };
  const stns = Array.isArray(norm.stations) ? norm.stations : [];
  const s = stns.find((x) => str(x.code).toUpperCase() === code);
  if (!s) return { ...base, state: 'unknown', note: norm.statusText || '' };
  const isCur = str(norm.currentCode).toUpperCase() === code;
  let state = 'upcoming';
  if (s.hasArrived) state = isCur && (!norm.ahead || /^at station$/i.test(norm.ahead)) ? 'at' : 'departed';
  const origin = s === stns[0] && (!s.sta || s.sta === s.std);
  const sta = origin ? s.std : s.sta, eta = origin ? (s.etd || s.eta) : (s.eta || s.etd);
  // Delay from the times when both are known (handles midnight), else IRCTC's number.
  let delay = s.delayMinutes || 0;
  const a = minsOf(sta), b = minsOf(eta);
  if (a != null && b != null && !(origin && eta === '00:00')) delay = ((b - a + 1440 + 720) % 1440) - 720;
  const platform = /^[1-9]\d*[A-Z]?$/i.test(str(s.platform)) ? str(s.platform) : '';
  return {
    ...base, state,
    sta, eta: eta === '00:00' && origin ? sta : eta,
    std: s.std || '', etd: s.etd || '',
    delayMinutes: delay, platform,
    note: state === 'unknown' ? (norm.statusText || '') : '',
  };
}

function withInfo(t, code) {
  const info = cacheGet(`tinfo:${t.number}`);
  const out = info ? { ...t, ...info } : { ...t };
  if (t.startDay >= 0 && t.startDay <= 4) {
    const cached = cacheGet(`live:${t.number}:${t.startDay}`) || cacheGet(`blive:${t.number}:${t.startDay}`);
    if (cached) out.live = boardView(cached, code);
  }
  return out;
}

function mockBoard(code, hours, now = Date.now()) {
  const base = now - (now % 60e3);
  const mk = (number, name, inMin, originCode, originName, destCode, destName) => {
    const at = base + inMin * 60e3;
    const min = Math.floor((at - istMidnight(istDateOf(at))) / 60e3);
    return { number, name, type: 'Mail Express', runsOn: 'Daily', arrival: hm(min), departure: hm((min + 1) % 1440), at, startDay: 0, originCode, originName, destCode, destName };
  };
  return {
    source: 'mock', station: code, hours, to: '', toUnavailable: false, generatedAt: now,
    trains: [
      mk('17406', 'Krishna Express', 25, 'ADB', 'Adilabad', 'TPTY', 'Tirupati'),
      mk('12706', 'Intercity SF Express', 80, 'SC', 'Secunderabad Jn', 'GNT', 'Guntur Jn'),
      mk('18045', 'East Coast Express', 150, 'SHM', 'Shalimar', 'CHZ', 'Charlapalli'),
    ],
  };
}

// GET /api/public/train/station?code=KMT&hours=8&to=SC
exports.station = async (req, res) => {
  const code = str(req.query.code).toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(code)) return res.status(400).json({ error: 'Choose a station.' });
  const hours = BOARD_HOURS.includes(+req.query.hours) ? +req.query.hours : 8;
  const to = str(req.query.to).toUpperCase();
  if (to && !/^[A-Z0-9]{1,6}$/.test(to)) return res.status(400).json({ error: 'Choose a valid destination station.' });
  if (!RAPIDAPI_KEY) return res.json(mockBoard(code, hours));
  const now = Date.now();
  try {
    const key = `board:${code}:${hours}`;
    let board = cacheGet(key);
    if (!board && !_cache.has(key)) { await redisGet(key); board = cacheGet(key); }
    let servedStale = false;
    if (!board) {
      // getLiveStation is the slowest call of the lot (~5 s). If we hold a copy
      // past its TTL, the reader gets it now and the refresh happens behind them.
      const stale = cacheGetStale(key);
      if (stale) {
        board = stale;
        servedStale = true;
        refreshBoard(code, hours);
      } else {
        board = normBoard(await rapid('/api/v3/getLiveStation', { fromStationCode: code, hours: String(hours) }), now);
        cacheSet(key, board, BOARD_TTL);
        boardRemember(code, board.trains, now);
      }
    }
    let trains = boardWithRecent(code, board.trains, now).map((t) => withInfo(t, code));
    // "To station": keep trains that go on to it — IRCTC's own list of trains leaving
    // this station for `to` on that date (the same cached call as the between page).
    let toUnavailable = false;
    if (to && to !== code) {
      const dates = [...new Set(trains.map((t) => istDateOf(t.at)))];
      const settled = await Promise.allSettled(dates.map((dt) => fetchBetweenDay(code, to, dt)));
      const byDate = new Map();
      settled.forEach((r, i) => { if (r.status === 'fulfilled') byDate.set(dates[i], new Set((r.value.trains || []).map((x) => x.number))); });
      if (byDate.size < dates.length) toUnavailable = true;
      if (byDate.size) trains = trains.filter((t) => { const set = byDate.get(istDateOf(t.at)); return set ? set.has(t.number) : true; });
    }
    return res.json({ source: 'live', stale: servedStale, station: code, hours, to, toUnavailable, generatedAt: now, trains });
  } catch (e) {
    const status = (e && e.response && e.response.status) || (e && e.message);
    console.error('train upstream failed:', status);
    const rescue = cacheGetStale(`board:${code}:${hours}`);
    if (rescue) {
      const trains = boardWithRecent(code, rescue.trains, now).map((t) => withInfo(t, code));
      return res.json({ source: 'live', stale: true, station: code, hours, to: '', toUnavailable: false, generatedAt: now, trains });
    }
    return res.status(503).json({
      source: 'unavailable', note: 'live_unavailable', upstreamStatus: status,
      error: 'Live train data is temporarily unavailable. Please try again in a few minutes.',
    });
  }
};

// GET /api/public/train/station/live?code=KMT&trains=17406.1,12706.0
// Live details for the board cards on screen: "<train>.<startDay>" pairs (max 12).
exports.stationLive = async (req, res) => {
  const code = str(req.query.code).toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(code)) return res.status(400).json({ error: 'Choose a station.' });
  const items = [...new Set(str(req.query.trains).split(',').map((x) => x.trim()))]
    .map((x) => x.match(/^(\d{4,6})\.([0-4])$/)).filter(Boolean).slice(0, BOARD_LIVE_MAX)
    .map((m) => ({ key: `${m[1]}.${m[2]}`, number: m[1], day: +m[2] }));
  if (!items.length) return res.status(400).json({ error: 'No trains given.' });
  if (!RAPIDAPI_KEY) {
    const live = {};
    items.forEach((it, i) => { live[it.key] = { originCode: '', originName: '', destCode: '', destName: '', state: 'upcoming', sta: '', eta: '', std: '', etd: '', delayMinutes: i * 7, platform: String((i % 3) + 1), note: '' }; });
    return res.json({ source: 'mock', live });
  }
  // A few at a time — RapidAPI plans also limit requests per second.
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { ok: true, v: boardView(await boardLive(items[i].number, items[i].day), code) }; }
      catch (e) { results[i] = { ok: false, e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  if (!results.some((r) => r.ok)) {
    const e = results[0].e;
    const status = (e && e.response && e.response.status) || (e && e.message);
    console.error('train upstream failed:', status);
    return res.status(503).json({
      source: 'unavailable', note: 'live_unavailable', upstreamStatus: status,
      error: 'Live train data is temporarily unavailable. Please try again in a few minutes.',
    });
  }
  const live = {};
  items.forEach((it, i) => { live[it.key] = results[i].ok ? results[i].v : { state: 'error' }; });
  return res.json({ source: 'live', live });
};

// GET /api/public/train/health — tells the app whether live data is on.
/**
 * Keep the busiest boards warm.
 *
 * Even with stale-while-revalidate, the FIRST reader of a station still pays the
 * ~5 s getLiveStation call. Fetching the handful of stations our readers
 * actually use — on boot and every few minutes — means that first reader is
 * usually somebody's background timer, not a person staring at a spinner.
 *
 * Deliberately small: each station is one upstream call, and RapidAPI bills per
 * call. WARM_STATIONS can be overridden with TRAIN_WARM_STATIONS in .env.
 */
const WARM_STATIONS = (process.env.TRAIN_WARM_STATIONS || 'BZA,SC,MAS,HYB,GNT,TPTY,VSKP,RJY')
  .split(',').map((x) => x.trim().toUpperCase()).filter(Boolean).slice(0, 12);
const WARM_EVERY_MS = 4 * 60e3;   // just inside the 5-minute board TTL

let _warmTimer = null;
async function warmBoards() {
  if (!RAPIDAPI_KEY) return;
  for (const code of WARM_STATIONS) {
    const key = `board:${code}:8`;
    if (cacheGet(key)) continue;                 // still fresh, nothing to do
    if (!_cache.has(key)) await redisGet(key);
    if (cacheGet(key)) continue;
    refreshBoard(code, 8);
    // Space the calls out: eight at once would spike RapidAPI and could trip a
    // rate limit, which would hurt real readers.
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Called once from server.js. Safe to call twice; the timer is single. */
exports.startWarmup = () => {
  if (_warmTimer || !RAPIDAPI_KEY) return;
  // Let the process finish booting first — warming must never delay startup.
  setTimeout(() => { warmBoards().catch(() => {}); }, 20e3);
  _warmTimer = setInterval(() => { warmBoards().catch(() => {}); }, WARM_EVERY_MS);
  if (_warmTimer.unref) _warmTimer.unref();
  console.log(`🚆 train: keeping ${WARM_STATIONS.length} station boards warm (${WARM_STATIONS.join(', ')})`);
};

exports.health = (req, res) => res.json({ ok: true, mode: RAPIDAPI_KEY ? 'live' : 'mock', host: RAPIDAPI_HOST });

// Internals exposed for unit tests only.
exports._test = { normBetween, normLive, normBoard, boardView, normPnr, seatStatus, isoDate, istToday, ALL_DAYS_TTL, ALL_DAYS_RETRY_TTL, BOARD_RECENT_MS };
