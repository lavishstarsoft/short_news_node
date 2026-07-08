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

  let resolvedName = input;
  if (isObjectIdString(input)) {
    const byId = await Category.findById(input).select('name').lean();
    if (byId?.name) resolvedName = byId.name;
  } else {
    const byName = await Category.findOne({ name: input }).select('name').lean();
    if (byName?.name) resolvedName = byName.name;
  }

  // Map display category filters to query database category names
  const lower = resolvedName.toLowerCase();
  if (lower.includes('politics') || lower.includes('political') || lower.includes('happening') || lower.includes('రాజకీయాలు')) {
    return { $in: ['Politics', 'Political/Happening', 'రాజకీయాలు'] };
  } else if (lower.includes('business') || lower.includes('వ్యాపారం')) {
    return { $in: ['Business', 'వ్యాపారం'] };
  } else if (lower.includes('sports') || lower.includes('event') || lower.includes('క్రీడలు')) {
    return { $in: ['Sports', 'Event/Sports', 'క్రీడలు'] };
  } else if (lower.includes('movie') || lower.includes('cinema') || lower.includes('సినిమా')) {
    return { $in: ['Movies', 'సినిమాలు', 'సినిమా', 'Cinema'] };
  } else if (lower.includes('special') || lower.includes('issue') || lower.includes('ప్రత్యేకం')) {
    return { $in: ['Special', 'Issues', 'ప్రత్యేకం'] };
  } else if (lower.includes('news') || lower.includes('admin') || lower.includes('infra') || lower.includes('crime') || lower.includes('accident') || lower.includes('వార్తలు')) {
    return { $in: ['News', 'వార్తలు', 'Administration/Infra', 'Crime/Accident'] };
  }

  return resolvedName;
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
