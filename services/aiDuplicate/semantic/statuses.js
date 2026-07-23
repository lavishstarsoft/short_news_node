'use strict';

/**
 * news_vectors.status contract — Phase-3B.1.
 */

const { STATUS } = require('./constants');

const ALLOWED = new Set(Object.values(STATUS));

function isValidNewsVectorStatus(status) {
  return ALLOWED.has(status);
}

function assertNewsVectorStatus(status) {
  if (!isValidNewsVectorStatus(status)) {
    throw new Error(
      `Invalid news_vectors.status "${status}". Allowed: ${[...ALLOWED].join(', ')}`
    );
  }
  return status;
}

module.exports = {
  STATUS,
  ALLOWED_STATUSES: [...ALLOWED],
  isValidNewsVectorStatus,
  assertNewsVectorStatus,
};
