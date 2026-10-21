import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { AppError } from '../utils/AppError.js';

const { accessSecret, accessTtl, issuer, audience } = config.auth;

export const tokenService = {
  /** Short-lived access token. `sid` ties it to a server-side session so logout revokes it. */
  signAccessToken({ userId, sessionId }) {
    return jwt.sign({ sid: sessionId, typ: 'access' }, accessSecret, {
      subject: String(userId),
      expiresIn: accessTtl,
      issuer,
      audience,
      algorithm: 'HS256',
    });
  },

  /** Returns { userId, sessionId, expiresAt } or throws 401. */
  verifyAccessToken(token) {
    try {
      const payload = jwt.verify(token, accessSecret, { algorithms: ['HS256'], issuer, audience });
      const userId = Number(payload.sub);
      const sessionId = Number(payload.sid);
      if (payload.typ !== 'access' || !Number.isSafeInteger(userId) || !Number.isSafeInteger(sessionId)) {
        throw new Error('Malformed token');
      }
      return { userId, sessionId, expiresAt: new Date(payload.exp * 1000) };
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) throw new AppError(401, 'TOKEN_EXPIRED', 'Access token expired');
      throw AppError.unauthorized('Invalid access token');
    }
  },

  /** Opaque, high-entropy refresh token (only its hash is stored). */
  generateRefreshToken() {
    return crypto.randomBytes(48).toString('base64url');
  },

  hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  },

  refreshExpiry(from = new Date()) {
    return new Date(from.getTime() + config.auth.refreshTtlDays * 24 * 60 * 60 * 1000);
  },
};
