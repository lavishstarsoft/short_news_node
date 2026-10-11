'use strict';

/**
 * Reporter place search (step 1/4) and status (step 2/4) share one area:
 * the district HQ/city is pickable, new districts search their parent districts,
 * renamed / wrong-state districts resolve — and nothing outside the area is reachable.
 */

// ── A tiny slice of the LGD data ──
const mockGeo = [];
const st = (code, name) => mockGeo.push({ type: 'state', code, name, search: name.toLowerCase() });
const dist = (code, name, stateCode, stateName) => mockGeo.push({ type: 'district', code, name, search: name.toLowerCase(), stateCode, stateName });
const place = (type, code, name, districtCode, districtName, stateName, mandalName = '') =>
  mockGeo.push({ type, code, name, search: name.toLowerCase(), districtCode, districtName, stateName, mandalName, mandalCode: mandalName ? 'm-' + mandalName : '' });

st('23', 'Madhya Pradesh'); st('09', 'Uttar Pradesh'); st('28', 'Andhra Pradesh'); st('07', 'Delhi');
st('33', 'Tamil Nadu'); st('27', 'Maharashtra'); st('10', 'Bihar');
dist('407', 'GWALIOR', '23', 'MADHYA PRADESH');
place('mandal', 'g1', 'Murar', '407', 'GWALIOR', 'MADHYA PRADESH');
place('mandal', 'g2', 'City center', '407', 'GWALIOR', 'MADHYA PRADESH');
place('village', 'g3', 'Barai', '407', 'GWALIOR', 'MADHYA PRADESH', 'Gird');
dist('426', 'SATNA', '23', 'MADHYA PRADESH');
place('mandal', 's1', 'Maihar', '426', 'SATNA', 'MADHYA PRADESH');
dist('405', 'EAST NIMAR', '23', 'MADHYA PRADESH');
place('mandal', 'k1', 'Khandwa', '405', 'EAST NIMAR', 'MADHYA PRADESH');
dist('174', 'PRATAPGARH', '09', 'UTTAR PRADESH');
place('village', 'p1', 'Kunda', '174', 'PRATAPGARH', 'UTTAR PRADESH', 'Kunda');
dist('140', 'GHAZIABAD', '09', 'UTTAR PRADESH');
place('mandal', 'z1', 'Modinagar', '140', 'GHAZIABAD', 'UTTAR PRADESH');
dist('99', 'NEW DELHI', '07', 'DELHI');
place('village', 'n1', 'Chanakyapuri', '99', 'NEW DELHI', 'DELHI');
// Delhi directional districts — the shorter names ("EAST","NORTH") are substrings
// of the longer ones, which used to make "North East Delhi" resolve to "EAST".
dist('78', 'EAST', '07', 'DELHI');
place('village', 'de1', 'Preet Vihar', '78', 'EAST', 'DELHI');
dist('79', 'NORTH', '07', 'DELHI');
place('village', 'dn1', 'Alipur', '79', 'NORTH', 'DELHI');
dist('81', 'NORTH EAST', '07', 'DELHI');
place('mandal', 'dne1', 'Karawal Nagar', '81', 'NORTH EAST', 'DELHI');
place('village', 'dne2', 'Karawal Nagar (CT)', '81', 'NORTH EAST', 'DELHI', 'Karawal Nagar');
dist('505', 'EAST GODAVARI', '28', 'ANDHRA PRADESH');
place('mandal', 'e1', 'Tuni', '505', 'EAST GODAVARI', 'ANDHRA PRADESH');
dist('746', 'Kakinada', '28', 'ANDHRA PRADESH'); // new district — no villages in the LGD data
dist('502', 'CHITTOOR', '28', 'ANDHRA PRADESH');
place('mandal', 'c1', 'Srikalahasti', '502', 'CHITTOOR', 'ANDHRA PRADESH');
dist('515', 'SPSR NELLORE', '28', 'ANDHRA PRADESH');
place('mandal', 'l1', 'Gudur', '515', 'SPSR NELLORE', 'ANDHRA PRADESH');
dist('752', 'Tirupati', '28', 'ANDHRA PRADESH');
dist('517', 'PRAKASAM', '28', 'ANDHRA PRADESH');
place('mandal', 'r1', 'Markapur', '517', 'PRAKASAM', 'ANDHRA PRADESH');
dist('504', 'Y.S.R.', '28', 'ANDHRA PRADESH');
place('mandal', 'y1', 'Proddatur', '504', 'Y.S.R.', 'ANDHRA PRADESH');
dist('594', 'TUTICORIN', '33', 'TAMIL NADU');
place('mandal', 't1', 'Kovilpatti', '594', 'TUTICORIN', 'TAMIL NADU');
dist('469', 'AURANGABAD', '27', 'MAHARASHTRA');
dist('189', 'AURANGABAD', '10', 'BIHAR');

function mockMatch(doc, filter) {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$in' in v) return v.$in.includes(doc[k]);
      if ('$regex' in v) return new RegExp(v.$regex).test(doc[k]);
      if ('$ne' in v) return doc[k] !== v.$ne;
    }
    return doc[k] === v;
  });
}
function mockQuery(rows) {
  let out = rows;
  const q = {
    select() { return q; },
    sort(spec) { const [[f, dir]] = Object.entries(spec); out = [...out].sort((a, b) => (a[f] > b[f] ? dir : -dir)); return q; },
    limit(n) { out = out.slice(0, n); return q; },
    lean: async () => out,
  };
  return q;
}
jest.mock('../models/GeoLocation', () => ({
  findOne: jest.fn((f) => { const q = mockQuery(mockGeo.filter((d) => mockMatch(d, f)).slice(0, 1)); const lean = q.lean; q.lean = async () => (await lean())[0] || null; return q; }),
  find: jest.fn((f) => mockQuery(mockGeo.filter((d) => mockMatch(d, f)))),
  countDocuments: jest.fn(async (f) => mockGeo.filter((d) => mockMatch(d, f)).length),
}));

const mockAdmins = {};
jest.mock('../models/Admin', () => ({
  findById: jest.fn((id) => ({ select() { return this; }, lean: async () => mockAdmins[id] || null })),
  find: jest.fn(() => ({ select() { return this; }, lean: async () => [] })),
}));
jest.mock('../models/News', () => ({
  aggregate: jest.fn(async () => []),
  countDocuments: jest.fn(async () => 0),
}));

const News = require('../models/News');
const { searchVillages } = require('../controllers/reporterVillageController');
const { locationStatus } = require('../controllers/reporterLocationStatusController');
const { reporterGeoScope, _clearScopeCache } = require('../services/reporterGeoScope');

function res() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
function reporter(id, state, districts, states) {
  mockAdmins[id] = { assignedState: state, assignedStates: states || [state], assignedDistricts: districts };
  return id;
}
async function search(id, q) { const r = res(); await searchVillages({ admin: { id }, query: { q } }, r); return r.body; }
async function status(id, code, type) { const r = res(); await locationStatus({ admin: { id }, query: { code, type } }, r); return r; }
const names = (b) => b.villages.map((v) => v.name);

beforeEach(() => { _clearScopeCache(); News.countDocuments.mockClear(); });

describe('a city district (Gwalior)', () => {
  const id = reporter('vikas', 'Madhya Pradesh', ['Gwalior']);

  test('typing "Gwalior" finds the district HQ / city', async () => {
    const b = await search(id, 'gwal');
    expect(b.villages).toEqual([{ name: 'Gwalior', code: '407', type: 'district', mandal: 'District HQ / City', mandalCode: '', district: 'Gwalior', state: 'MADHYA PRADESH' }]);
  });

  test('other searches are unchanged — villages and tehsils only', async () => {
    expect(names(await search(id, 'mur'))).toEqual(['Murar']);
    expect(names(await search(id, 'city'))).toEqual(['City center']);
  });

  test('an empty search lists the HQ first, then places', async () => {
    expect(names(await search(id, ''))[0]).toBe('Gwalior');
  });

  test('step 2/4 accepts the HQ; the news location will read "Gwalior"', async () => {
    const r = await status(id, '407', 'district');
    expect(r.statusCode).toBe(200);
    expect(r.body.place).toMatchObject({ name: 'Gwalior', type: 'district', district: 'Gwalior', mandal: '' });
    expect(r.body.district.name).toBe('Gwalior');
    // "news already posted here" counts stories whose location is Gwalior.
    expect(News.countDocuments.mock.calls[0][0].$expr.$in[1]).toEqual(['gwalior']);
  });

  test("another district's HQ is refused", async () => {
    expect((await status(id, '174', 'district')).statusCode).toBe(404);
  });
});

test('a normal district is untouched: no HQ row unless its name is typed', async () => {
  const id = reporter('pr', 'Uttar Pradesh', ['Pratapgarh']);
  expect((await search(id, 'ku')).villages).toEqual([
    { name: 'Kunda', code: 'p1', type: 'village', mandal: 'Kunda', mandalCode: 'm-Kunda', district: 'PRATAPGARH', state: 'UTTAR PRADESH' },
  ]);
  expect((await status(id, 'p1', 'village')).body.place.district).toBe('PRATAPGARH');
});

describe('new districts with no villages in the data', () => {
  test('Kakinada searches East Godavari, and its places show as Kakinada', async () => {
    const id = reporter('kk', 'Andhra Pradesh', ['Kakinada']);
    const b = await search(id, 'tun');
    expect(b.mapped).toBe(true);
    expect(b.villages).toEqual([expect.objectContaining({ name: 'Tuni', district: 'Kakinada' })]);
    expect(names(await search(id, 'kak'))).toEqual(['Kakinada']); // its HQ row too
    const r = await status(id, 'e1', 'mandal');
    expect(r.statusCode).toBe(200);
    expect(r.body.place.district).toBe('Kakinada');
    expect(r.body.district.name).toBe('Kakinada');
  });

  test('Tirupati searches both its parents (Chittoor + Nellore)', async () => {
    const scope = await reporterGeoScope({ assignedState: 'Andhra Pradesh', assignedDistricts: ['Tirupati'] });
    expect(scope.units[0]).toMatchObject({ districtCode: '752', fromParents: true, searchCodes: ['502', '515'] });
  });

  test('Markapuram is not in the data at all → Prakasam villages, no HQ row', async () => {
    const id = reporter('mk', 'Andhra Pradesh', ['Markapuram']);
    expect(names(await search(id, 'mark'))).toEqual(['Markapur']);
  });
});

describe('districts that did not resolve', () => {
  test('filed under the wrong state (Ghaziabad under Delhi) → found by its unique name', async () => {
    const id = reporter('gz', 'Delhi', ['Ghaziabad']);
    expect(names(await search(id, 'modi'))).toEqual(['Modinagar']);
  });

  test('an ambiguous name under the wrong state is NOT guessed', async () => {
    const id = reporter('au', 'Delhi', ['Aurangabad']);
    expect((await search(id, 'a')).mapped).toBe(false);
  });

  test.each([
    ['Andhra Pradesh', 'Kadapa', 'prod', 'Proddatur'],
    ['Tamil Nadu', 'Thoothukudi', 'kov', 'Kovilpatti'],
    ['Madhya Pradesh', 'Khandwa', 'khan', 'Khandwa'],
  ])('renamed: %s / %s', async (state, d, q, expected) => {
    const id = reporter('al-' + d, state, [d]);
    expect(names(await search(id, q))).toContain(expected);
  });
});

describe('a district whose name contains a shorter district (Delhi directions)', () => {
  test('"North East Delhi" resolves to NORTH EAST, not EAST or NORTH', async () => {
    const scope = await reporterGeoScope({ assignedState: 'Delhi', assignedDistricts: ['North East Delhi'] });
    expect(scope.units[0]).toMatchObject({ districtCode: '81', districtName: 'NORTH EAST' });
  });

  test('the reporter can find their own locality (Karawal Nagar), not the wrong district', async () => {
    const id = reporter('ne', 'Delhi', ['North East Delhi']);
    const found = names(await search(id, 'karawal'));
    expect(found).toEqual(expect.arrayContaining(['Karawal Nagar', 'Karawal Nagar (CT)']));
    expect(names(await search(id, 'preet'))).not.toContain('Preet Vihar'); // that is EAST, a different district
  });

  test('plain "East Delhi" still resolves to EAST', async () => {
    const scope = await reporterGeoScope({ assignedState: 'Delhi', assignedDistricts: ['East Delhi'] });
    expect(scope.units[0]).toMatchObject({ districtCode: '78', districtName: 'EAST' });
  });

  test('a shorter assigned name still finds its wrapping district (Nellore → SPSR NELLORE)', async () => {
    const code = (await reporterGeoScope({ assignedState: 'Andhra Pradesh', assignedDistricts: ['Nellore'] })).units[0].districtCode;
    expect(code).toBe('515');
  });
});

test('a reporter with two districts can use a place in the second one (step 2/4 used to check only the first)', async () => {
  const id = reporter('two', 'Madhya Pradesh', ['Gwalior', 'Satna']);
  expect(names(await search(id, 'mai'))).toEqual(['Maihar']);
  const r = await status(id, 's1', 'mandal');
  expect(r.statusCode).toBe(200);
  expect(r.body.district.name).toBe('Satna');
});

describe('nothing outside the area is reachable', () => {
  const id = reporter('safe', 'Madhya Pradesh', ['Gwalior']);
  test('a village in another district → 404', async () => {
    expect((await status(id, 'p1', 'village')).statusCode).toBe(404);
  });
  test('an unknown place type → 400', async () => {
    expect((await status(id, '23', 'state')).statusCode).toBe(400);
  });
  test('no districts assigned → says so', async () => {
    const none = reporter('none', 'Madhya Pradesh', []);
    expect((await search(none, 'g')).assigned).toBe(false);
  });
});
