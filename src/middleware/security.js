import { rateLimit } from 'express-rate-limit';
import { config } from '../config/index.js';
import { AppError } from '../utils/AppError.js';

function limiter({ windowMs, limit, message, ...rest }) {
  return rateLimit({
    windowMs,
    // Tests hammer the API from one IP; they opt into higher limits via env.
    limit: config.isTest ? Number(process.env.TEST_RATE_LIMIT ?? 10_000) : limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', message)),
    ...rest,
  });
}

export const rateLimiters = {
  api: limiter({
    windowMs: 60_000,
    limit: 300,
    message: 'Too many requests, please slow down',
    // Viewing a chat full of photos loads many files; downloads are cheap, authenticated reads.
    skip: (req) => req.method === 'GET' && req.path.startsWith('/attachments/'),
  }),
  // Failed logins only: successful sign-ins do not count against the user.
  login: limiter({
    windowMs: 15 * 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
    message: 'Too many failed sign-in attempts. Please try again in 15 minutes.',
  }),
  register: limiter({ windowMs: 60 * 60_000, limit: 20, message: 'Too many accounts created. Please try again later.' }),
  refresh: limiter({ windowMs: 60_000, limit: 30, message: 'Too many requests, please slow down' }),
  // Emailing codes costs money/reputation and can be used to spam someone's inbox.
  otpSend: limiter({ windowMs: 15 * 60_000, limit: 10, message: 'Too many code requests. Please try again later.' }),
  otpVerify: limiter({ windowMs: 15 * 60_000, limit: 30, message: 'Too many attempts. Please try again later.' }),
  upload: limiter({ windowMs: 60 * 60_000, limit: 30, message: 'Too many uploads. Please try again later.' }),
  attachmentUpload: limiter({ windowMs: 60 * 60_000, limit: 300, message: 'Too many files sent. Please try again later.' }),
  search: limiter({ windowMs: 60_000, limit: 60, message: 'Too many searches, please slow down' }),
  messageActions: limiter({ windowMs: 60_000, limit: 120, message: 'You are doing that too fast. Please slow down.' }),
  messages: limiter({ windowMs: 60_000, limit: 120, message: 'You are sending messages too fast' }),
  // Call recordings upload a chunk every few seconds per recording.
  recordings: limiter({ windowMs: 60_000, limit: 120, message: 'Too many recording uploads. Please slow down.' }),
};

/**
 * CSRF guard for the cookie-authenticated endpoints (refresh/logout). Browsers
 * cannot send this custom header cross-origin without passing CORS preflight.
 */
export function requireXhr(req, _res, next) {
  if (req.get('x-requested-with') !== 'XMLHttpRequest') {
    return next(AppError.forbidden('Missing X-Requested-With header'));
  }
  next();
}
