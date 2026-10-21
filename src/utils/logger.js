import { config } from '../config/index.js';

const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|cookie|hash|otp/i;

/** Recursively replace sensitive values so they never reach the logs. */
export function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (value instanceof Error) {
    // Database errors can quote stored values (e.g. an email in "Duplicate entry …"): keep only codes in production.
    const fromDatabase = 'sqlMessage' in value || 'sqlState' in value;
    return {
      name: value.name,
      message: config.isProduction && fromDatabase ? '[database error]' : value.message,
      code: value.code,
      ...(fromDatabase ? { errno: value.errno } : {}),
      stack: config.isProduction ? undefined : value.stack,
    };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item, depth + 1)]),
  );
}

function write(level, message, meta) {
  if (config.isTest && level !== 'error') return;
  const entry = { time: new Date().toISOString(), level, message, ...(meta ? redact(meta) : {}) };
  const line = config.isProduction ? JSON.stringify(entry) : `[${entry.time}] ${level.toUpperCase()} ${message}${meta ? ` ${JSON.stringify(redact(meta))}` : ''}`;
  (level === 'error' ? console.error : console.log)(line);
}

export const logger = {
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
