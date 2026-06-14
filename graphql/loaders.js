const DataLoader = require('dataloader');
const mongoose = require('mongoose');
const Admin = require('../models/Admin');

// Batches many Admin.findById(authorId) calls (one per news item) into a single
// `$in` query per request, eliminating the N+1 query pattern on author fields.
function createAdminLoader() {
  return new DataLoader(async (ids) => {
    const validIds = ids.filter((id) => mongoose.Types.ObjectId.isValid(id));
    const admins = validIds.length
      ? await Admin.find({ _id: { $in: validIds } })
      : [];

    const byId = new Map();
    admins.forEach((admin) => byId.set(String(admin._id), admin));

    // DataLoader requires the result array to match the input order/length.
    return ids.map((id) => byId.get(String(id)) || null);
  });
}

// Fresh loaders per request so cached values never leak across users/requests.
function createLoaders() {
  return {
    adminById: createAdminLoader(),
  };
}

module.exports = { createLoaders };
