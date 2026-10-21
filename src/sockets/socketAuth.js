import { config } from '../config/index.js';
import { authService } from '../services/authService.js';
import { e2eeService } from '../services/e2eeService.js';
import { presenceService } from '../services/presenceService.js';

/**
 * Socket.IO handshake middleware. The client sends its access token in
 * `auth.token`; the socket is bound to that user and session for its lifetime.
 */
export async function socketAuth(socket, next) {
  try {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
      throw Object.assign(new Error('Authentication required'), { code: 'UNAUTHORIZED' });
    }
    const { user, sessionId, expiresAt } = await authService.authenticate(token);
    if (presenceService.socketCount(user.id) >= config.sockets.maxPerUser) {
      throw Object.assign(new Error('Too many open connections'), { code: 'TOO_MANY_CONNECTIONS' });
    }
    socket.data.user = user;
    socket.data.sessionId = sessionId;
    socket.data.tokenExpiresAt = expiresAt;
    // Stable per browser tab across reconnects (calls are bound to a tab). Older clients: per socket.
    const tabId = socket.handshake.auth?.tabId;
    // This tab's encryption device (if set up and really the user's).
    const deviceId = Number(socket.handshake.auth?.deviceId);
    socket.data.deviceId = Number.isSafeInteger(deviceId) && deviceId > 0 && (await e2eeService.isOwnDevice(user.id, deviceId)) ? deviceId : null;
    socket.data.tabId = typeof tabId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(tabId) ? tabId : socket.id;
    next();
  } catch (error) {
    const err = new Error('UNAUTHORIZED');
    err.data = { code: ['TOKEN_EXPIRED', 'TOO_MANY_CONNECTIONS'].includes(error.code) ? error.code : 'UNAUTHORIZED' };
    next(err);
  }
}
