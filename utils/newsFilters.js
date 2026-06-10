const mongoose = require('mongoose');
const Category = require('../models/Category');
const Location = require('../models/Location');

function normalizeFilterInput(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') return null;
  return trimmed;
}

function isObjectIdString(value) {
  return mongoose.Types.ObjectId.isValid(value) && /^[a-fA-F0-9]{24}$/.test(value);
}

/**
 * Resolve a category filter from app/admin input (name or legacy ObjectId)
 * to the category name stored on news documents.
 */
async function resolveCategoryFilter(category) {
  const input = normalizeFilterInput(category);
  if (!input) return null;

  if (isObjectIdString(input)) {
    const byId = await Category.findById(input).select('name').lean();
    if (byId?.name) return byId.name;
  }

  const byName = await Category.findOne({ name: input }).select('name').lean();
  if (byName?.name) return byName.name;

  // News articles store category names; allow direct name match even if
  // the category was removed from the master list.
  return input;
}

/**
 * Resolve a location filter from app/admin input (name or legacy ObjectId)
 * to the location name stored on news documents.
 */
async function resolveLocationFilter(location) {
  const input = normalizeFilterInput(location);
  if (!input) return null;

  if (isObjectIdString(input)) {
    const byId = await Location.findById(input).select('name').lean();
    if (byId?.name) return byId.name;
  }

  const byName = await Location.findOne({ name: input }).select('name').lean();
  if (byName?.name) return byName.name;

  return input;
}

module.exports = {
  normalizeFilterInput,
  resolveCategoryFilter,
  resolveLocationFilter,
};
