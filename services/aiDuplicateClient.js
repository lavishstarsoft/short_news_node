'use strict';

/**
 * Backward-compatible entrypoint for Phase-1.
 * Implementation lives in ./aiDuplicate (central infrastructure module).
 *
 * NOT required by server.js / newsController in Phase-1 — zero runtime impact
 * until something requires this module.
 */

module.exports = require('./aiDuplicate');
