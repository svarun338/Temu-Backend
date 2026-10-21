import { config } from '../config/index.js';
import { authService } from '../services/authService.js';
import { pushService } from '../services/pushService.js';
import { realtime } from '../sockets/realtime.js';

const { refreshCookieName, mediaCookieName } = config.auth;

const baseCookie = {
  httpOnly: true, // not readable from JavaScript → safe from XSS token theft
  secure: config.isProduction,
  sameSite: 'strict',
};
const refreshCookie = { ...baseCookie, path: '/api/auth' }; // only sent to the auth endpoints
// Lets <img>/<video>/<audio> load private attachments, which cannot send an Authorization
// header. It holds the short-lived access token and only travels to /api/attachments.
const mediaCookie = { ...baseCookie, path: '/api/attachments' };

/** Set the cookies of a signed-in session. */
function setSessionCookies(res, { refreshToken, refreshExpiresAt, accessToken }) {
  if (refreshToken) res.cookie(refreshCookieName, refreshToken, { ...refreshCookie, expires: refreshExpiresAt });
  res.cookie(mediaCookieName, accessToken, mediaCookie);
}

export function clearSessionCookies(res) {
  res.clearCookie(refreshCookieName, refreshCookie);
  res.clearCookie(mediaCookieName, mediaCookie);
}

const requestMeta = (req) => ({ userAgent: req.get('user-agent'), ip: req.ip });

export const authController = {
  /** Creates the account and emails a code; the session starts after verifyEmail. */
  async register(req, res) {
    const result = await authService.register(req.valid.body);
    res.status(201).json({ requiresVerification: true, ...result });
  },

  async verifyEmail(req, res) {
    const result = await authService.verifyEmail(req.valid.body, requestMeta(req));
    setSessionCookies(res, result);
    res.json({ user: result.user, accessToken: result.accessToken });
  },

  async resendVerification(req, res) {
    res.json({ sent: true, ...(await authService.resendVerification(req.valid.body)) });
  },

  async forgotPassword(req, res) {
    res.json({ sent: true, ...(await authService.forgotPassword(req.valid.body)) });
  },

  async resetPassword(req, res) {
    const { sessionIds } = await authService.resetPassword(req.valid.body);
    realtime.disconnectSessions(sessionIds);
    await pushService.removeForSessions(sessionIds);
    clearSessionCookies(res);
    res.json({ reset: true });
  },

  async login(req, res) {
    const result = await authService.login(req.valid.body, requestMeta(req));
    setSessionCookies(res, result);
    res.json({ user: result.user, accessToken: result.accessToken });
  },

  async refresh(req, res) {
    try {
      const result = await authService.refresh(req.cookies?.[refreshCookieName]);
      setSessionCookies(res, result);
      res.json({ user: result.user, accessToken: result.accessToken });
    } catch (error) {
      clearSessionCookies(res);
      throw error;
    }
  },

  async logout(req, res) {
    const sessionId = await authService.logoutByRefreshToken(req.cookies?.[refreshCookieName]);
    if (sessionId) {
      realtime.disconnectSessions([sessionId]);
      await pushService.removeForSessions([sessionId]);
    }
    clearSessionCookies(res);
    res.status(204).end();
  },

  async logoutAll(req, res) {
    const sessionIds = await authService.logoutAll(req.user.id);
    realtime.disconnectSessions(sessionIds);
    await pushService.removeForSessions(sessionIds);
    clearSessionCookies(res);
    res.status(204).end();
  },

  me(req, res) {
    res.json({ user: req.user });
  },
};
