const pino = require('pino');

const isProduction = process.env.NODE_ENV === 'production';

// Structured JSON logs in production (easy to ship to log aggregators); in
// development use pino-pretty for human-readable output. Level is configurable
// via LOG_LEVEL (default: info in prod, debug in dev).
const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  // Never log obvious secrets even if accidentally passed in.
  redact: {
    paths: [
      'password',
      '*.password',
      'token',
      '*.token',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[REDACTED]',
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      },
});

/**
 * In production, silence the hundreds of `console.log` / `console.debug` debug
 * statements scattered across the codebase so logs stay clean and cheap, while
 * routing warnings and errors through the structured logger. In development,
 * leave console.* untouched for convenience.
 */
function installConsoleBridge() {
  if (!isProduction) return;

  console.log = () => {};
  console.debug = () => {};
  console.info = (...args) => logger.info(args.map(String).join(' '));
  console.warn = (...args) => logger.warn(args.map(String).join(' '));
  console.error = (...args) => logger.error(args.map(String).join(' '));
}

module.exports = { logger, installConsoleBridge, isProduction };
