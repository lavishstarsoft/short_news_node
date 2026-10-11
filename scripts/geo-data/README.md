# India geography data (state → district → mandal → village)

India-wide administrative geography for the reporter district → mandal → village
pickers. **Additive and safe:** a separate `GeoLocation` model / `geolocations`
collection — it does NOT touch the business `Location` model or any news/wallet logic.

Source: [planemad/india-local-government-directory](https://github.com/planemad/india-local-government-directory),
a mirror of the official [Local Government Directory](https://lgdirectory.gov.in) (Census 2011 hierarchy).

## What's here

| File | Rows | Committed? | Notes |
|---|---|---|---|
| `data/states.json` | 36 | ✅ | states + UTs, LGD code, `isUT` |
| `data/districts.json` | 763 | ✅ | + `stateCode/stateName` |
| `data/mandals.json` | 6,921 | ✅ | sub-districts (mandal/tehsil/taluk) + district/state |
| `data/4-village.csv` | 662,270 | ❌ git-ignored | ~100 MB — download + seed, don't commit |
| `../../models/GeoLocation.js` | — | ✅ | schema + indexes |
| `seed-geo.js` | — | ✅ | seeds everything into Mongo |
| `download-villages.sh` | — | ✅ | fetches the village CSV |
| `geo-queries.example.js` | — | ✅ | copy-paste queries for the routes |

Every row is normalised to: `{ type, name, code, search, stateCode, stateName, districtCode, districtName, mandalCode, mandalName, status }`.
`search` is the lowercased English name (what prefix search runs against). Names are
English only — the LGD local-language (Telugu) names are sparse and were intentionally
dropped; reporters search and see English names.

## Format — two ways to use in Node.js

1. **Direct JSON** (states/districts/mandals are small): `require('./data/districts.json')`.
2. **MongoDB** (needed for villages — 6.6 lakh rows, fast indexed search): run the seed below.

## Seed

```bash
# states + districts + mandals only (fast, no download needed):
node scripts/geo-data/seed-geo.js

# add ALL-INDIA villages (all 35 states/UTs, ~6.62 lakh, English names) — the default:
bash scripts/geo-data/download-villages.sh
node scripts/geo-data/seed-geo.js --villages

# (optional) limit to certain states by LGD code, e.g. AP (28) + Telangana (36):
node scripts/geo-data/seed-geo.js --villages --states=28,36
```

Idempotent (upserts, safe to re-run/resume). Uses `process.env.MONGODB_URI`.
Uninhabited villages are skipped from search by default (`--include-uninhabited` to keep them).

## Query (reporter flow)

`geo-queries.example.js` has `districtsOfState`, `mandalsOfDistrict`, and
`searchVillages({ districtCode, q })` (indexed prefix autocomplete). Example route:

```js
// GET /api/public/villages?districtCode=532&q=gudi
const villages = await searchVillages({ districtCode, q, limit: 20 });
```

## ⚠️ Assembly-constituency caveat

LGD has **no reliable village↔assembly-constituency mapping** (its `constituency/`
folder covers only a couple of states). So the reporter flow searches villages
**within the assigned district** and stores the chosen constituency as a **tag**.
A tighter constituency filter for AP/TS would need a mandal→constituency mapping
added later (manual/curated). This matches how hyperlocal apps actually do it:
official base data + curation over time; reporters selecting/adding villages can
refine the set (crowdsource).

## Refresh

LGD updates monthly. Re-download the CSVs from the source repo's `administrative/`
folder and re-run the seed to update.
