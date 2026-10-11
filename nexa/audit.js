'use strict';

/**
 * TEHELKA NEXA — audit helper. Writes NexaTask records. Best-effort: an audit
 * failure must NEVER break a caller (NEXA is always non-blocking for prod).
 */

function record(entry) {
  return Promise.resolve()
    .then(() => {
      const NexaTask = require('../models/NexaTask');
      return NexaTask.create(entry);
    })
    .catch((err) => {
      // Never throw from audit.
      console.warn('[NEXA][audit] record failed:', err && err.message);
      return null;
    });
}

module.exports = { record };
