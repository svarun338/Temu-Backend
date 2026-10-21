import { config } from '../config/index.js';
import { authService } from '../services/authService.js';
import { e2eeService } from '../services/e2eeService.js';
import { AppError } from '../utils/AppError.js';

function bearerToken(req) {
  const [scheme, token] = (req.get('authorization') ?? '').split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

async function signIn(req, token) {
  const { user, sessionId } = await authService.authenticate(token);
  req.user = user;
  req.sessionId = sessionId;
  req.deviceId = await deviceFrom(req, user.id);
}

/**
 * The encryption device the request comes from (X-Device-Id), if it is one of the
 * user's active devices. Encrypted messages then include only that device's keys.
 */
async function deviceFrom(req, userId) {
  const raw = req.get('x-device-id');
  if (!raw || !/^\d{1,18}$/.test(raw)) return null;
  const deviceId = Number(raw);
  return (await e2eeService.isOwnDevice(userId, deviceId)) ? deviceId : null;
}

/**
 * Require a valid `Authorization: Bearer <access token>` whose session is still active.
 * Sets req.user (from the database, never from the client) and req.sessionId.
 */
export async function authenticate(req, _res, next) {
  const token = bearerToken(req);
  if (!token) return next(AppError.unauthorized());
  await signIn(req, token);
  next();
}

/**
 * For attachment downloads: like `authenticate`, but also accepts the media
 * cookie (same access token, httpOnly, SameSite=Strict, path /api/attachments),
 * because <img>/<video>/<audio> elements cannot send headers.
 */
export async function authenticateMedia(req, _res, next) {
  const token = bearerToken(req) ?? req.cookies?.[config.auth.mediaCookieName];
  if (!token) return next(AppError.unauthorized());
  await signIn(req, token);
  next();
}
