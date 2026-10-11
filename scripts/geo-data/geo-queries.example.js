/**
 * Ready-to-use queries over the `geolocations` collection. Copy these into a
 * routes file (e.g. routes/publicRoutes.js) when wiring the reporter pickers.
 * All are plain, indexed Mongo queries — no external service, no billing.
 */
const GeoLocation = require('../../models/GeoLocation');

/** All districts of a state (by LGD state code, e.g. '28' = Andhra Pradesh). */
async function districtsOfState(stateCode) {
  return GeoLocation.find({ type: 'district', stateCode }).sort({ name: 1 }).select('name code').lean();
}

/** All mandals (sub-districts) of a district. */
async function mandalsOfDistrict(districtCode) {
  return GeoLocation.find({ type: 'mandal', districtCode }).sort({ name: 1 }).select('name code').lean();
}

/**
 * Village autocomplete inside a reporter's district.
 * Prefix match first (uses the { type, districtCode, search } index), case-insensitive.
 * `q` is what the reporter typed; returns up to `limit` English-name suggestions.
 */
async function searchVillages({ districtCode, q, limit = 20 }) {
  const query = (q || '').trim().toLowerCase();
  const filter = { type: 'village', districtCode };
  if (query) filter.search = { $regex: '^' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
  return GeoLocation.find(filter).sort({ name: 1 }).limit(limit).select('name code mandalName').lean();
}

// Example Express handler (mount under /api/public):
//
//   router.get('/api/public/villages', async (req, res) => {
//     const { districtCode, q } = req.query;
//     if (!districtCode) return res.status(400).json({ error: 'districtCode required' });
//     const villages = await searchVillages({ districtCode, q, limit: 20 });
//     res.json({ success: true, villages });
//   });

module.exports = { districtsOfState, mandalsOfDistrict, searchVillages };
