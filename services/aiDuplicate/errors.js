'use strict';

class AiDuplicateError extends Error {
  constructor(message, code = 'AI_ERROR', details = null) {
    super(message);
    this.name = 'AiDuplicateError';
    this.code = code;
    this.details = details;
  }
}

function toSafeErrorMessage(err) {
  if (!err) return 'Unknown AI error';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  return 'AI request failed';
}

function isTimeoutError(err) {
  if (!err) return false;
  const code = err.code;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('timeout');
}

module.exports = {
  AiDuplicateError,
  toSafeErrorMessage,
  isTimeoutError,
};
