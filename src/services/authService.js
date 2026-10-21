import bcrypt from 'bcrypt';
import { config } from '../config/index.js';
import { sessionRepository } from '../repositories/sessionRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { otpService } from './otpService.js';
import { toUser } from './serializers.js';
import { tokenService } from './tokenService.js';

const INVALID_CREDENTIALS = 'Invalid email or password';

// Compared against when the email does not exist, so login takes the same time
// whether or not an account exists (prevents user enumeration by timing).
let dummyHash;
async function getDummyHash() {
  dummyHash ??= await bcrypt.hash('dummy-password-for-timing', config.auth.bcryptRounds);
  return dummyHash;
}

async function startSession(user, meta) {
  const refreshToken = tokenService.generateRefreshToken();
  const refreshExpiresAt = tokenService.refreshExpiry();
  const sessionId = await sessionRepository.create({
    userId: user.id,
    tokenHash: tokenService.hashToken(refreshToken),
    userAgent: meta.userAgent?.slice(0, 255) ?? null,
    ipAddress: meta.ip?.slice(0, 45) ?? null,
    expiresAt: refreshExpiresAt,
  });
  return {
    user: toUser(user),
    accessToken: tokenService.signAccessToken({ userId: user.id, sessionId }),
    refreshToken,
    refreshExpiresAt,
  };
}

const ACCOUNT_EXISTS = 'An account with this email already exists';

export const authService = {
  /**
   * Create an account and email a verification code. No session is started until
   * the email is verified. Re-registering a never-verified email replaces its
   * name/password (only the inbox owner can finish verification anyway).
   * Returns { email, retryAfterSeconds, devOtp? }.
   */
  async register({ name, email, password }) {
    const passwordHash = await bcrypt.hash(password, config.auth.bcryptRounds);
    let user = await userRepository.findByEmail(email);
    if (user?.email_verified_at) throw AppError.conflict(ACCOUNT_EXISTS);

    if (user) {
      if (!(await userRepository.resetUnverified(user.id, { name, passwordHash }))) throw AppError.conflict(ACCOUNT_EXISTS);
      user = await userRepository.findById(user.id);
    } else {
      try {
        user = await userRepository.findById(await userRepository.create({ name, email, passwordHash }));
      } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') throw AppError.conflict(ACCOUNT_EXISTS);
        throw error;
      }
      logger.info('User registered', { userId: user.id });
    }
    return { email: user.email, ...(await otpService.issue(user, 'verify_email')) };
  },

  /** Confirm the emailed code and sign the user in. */
  async verifyEmail({ email, code }, meta) {
    const user = await userRepository.findByEmail(email);
    if (!user) throw new AppError(400, 'INVALID_CODE', 'This code is invalid or has expired. Request a new one.');
    if (user.email_verified_at) throw new AppError(409, 'ALREADY_VERIFIED', 'This email is already verified. Please sign in.');
    await otpService.consume(user, 'verify_email', code);
    await userRepository.markEmailVerified(user.id, new Date());
    logger.info('Email verified', { userId: user.id });
    return startSession(await userRepository.findById(user.id), meta);
  },

  /** Send a new verification code. Same response whether or not the account exists. */
  async resendVerification({ email }) {
    const user = await userRepository.findByEmail(email);
    if (!user || user.email_verified_at) return { retryAfterSeconds: config.otp.resendCooldownSeconds };
    return otpService.issue(user, 'verify_email');
  },

  async login({ email, password }, meta) {
    const user = await userRepository.findByEmailWithPassword(email);
    const hash = user?.password_hash ?? (await getDummyHash());
    const valid = await bcrypt.compare(password, hash);
    if (!user || !valid) throw AppError.unauthorized(INVALID_CREDENTIALS);

    if (!user.email_verified_at) {
      // Correct password but unverified: send a fresh code (unless one was just sent).
      let delivery = {};
      try {
        delivery = await otpService.issue(user, 'verify_email');
      } catch (error) {
        if (!(error instanceof AppError) || error.status !== 429) throw error;
        delivery = { retryAfterSeconds: error.details?.retryAfterSeconds ?? config.otp.resendCooldownSeconds };
      }
      throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email address. We sent you a new code.', {
        email: user.email,
        ...delivery,
      });
    }
    return startSession(user, meta);
  },

  /**
   * Email a password-reset code. The response is the same whether or not the
   * account exists, so this cannot be used to discover registered emails.
   */
  async forgotPassword({ email }) {
    const user = await userRepository.findByEmail(email);
    if (!user) return { retryAfterSeconds: config.otp.resendCooldownSeconds };
    try {
      return await otpService.issue(user, 'reset_password');
    } catch (error) {
      if (error instanceof AppError && error.code === 'OTP_COOLDOWN') return { retryAfterSeconds: error.details.retryAfterSeconds };
      throw error;
    }
  },

  /**
   * Set a new password with an emailed code. Signs out every session (returned so
   * live sockets can be disconnected). Proving inbox access also verifies the email.
   */
  async resetPassword({ email, code, password }) {
    const user = await userRepository.findByEmail(email);
    if (!user) throw new AppError(400, 'INVALID_CODE', 'This code is invalid or has expired. Request a new one.');
    await otpService.consume(user, 'reset_password', code);
    await userRepository.updatePassword(user.id, await bcrypt.hash(password, config.auth.bcryptRounds));
    await userRepository.markEmailVerified(user.id, new Date());
    const sessionIds = await sessionRepository.revokeAllForUser(user.id, new Date());
    logger.info('Password reset', { userId: user.id });
    return { sessionIds };
  },

  /**
   * Exchange a refresh token for a new access token, rotating the refresh token.
   * Returns { user, accessToken, refreshToken?, refreshExpiresAt? } — no new refresh
   * token is issued when a just-rotated token is replayed inside the grace window.
   */
  async refresh(rawToken) {
    if (!rawToken) throw AppError.unauthorized('No active session');
    const now = new Date();
    const hash = tokenService.hashToken(rawToken);

    const session = await sessionRepository.findByTokenHash(hash);
    if (session && !session.revoked_at && session.expires_at > now) {
      const refreshToken = tokenService.generateRefreshToken();
      const refreshExpiresAt = tokenService.refreshExpiry(now);
      const rotated = await sessionRepository.rotate({
        id: session.id,
        currentHash: hash,
        newHash: tokenService.hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
        at: now,
      });
      if (rotated) return this.issueForSession(session, { refreshToken, refreshExpiresAt });
      // Lost a race with a parallel refresh: fall through to the grace-window check.
    }

    const previous = await sessionRepository.findByPreviousTokenHash(hash);
    if (previous && !previous.revoked_at && previous.expires_at > now) {
      const age = now - new Date(previous.rotated_at);
      if (age <= config.auth.refreshReuseGraceMs) return this.issueForSession(previous);
      // An old refresh token was replayed long after rotation: treat as theft.
      await sessionRepository.revoke(previous.id, now);
      logger.warn('Refresh token reuse detected; session revoked', { sessionId: previous.id });
    }
    throw AppError.unauthorized('Session expired, please sign in again');
  },

  async issueForSession(session, extra = {}) {
    const user = await userRepository.findById(session.user_id);
    if (!user) throw AppError.unauthorized('Session expired, please sign in again');
    return {
      user: toUser(user),
      accessToken: tokenService.signAccessToken({ userId: user.id, sessionId: session.id }),
      ...extra,
    };
  },

  /** Revoke the session identified by a refresh token. Returns the revoked session id (if any). */
  async logoutByRefreshToken(rawToken) {
    if (!rawToken) return null;
    const hash = tokenService.hashToken(rawToken);
    const session = (await sessionRepository.findByTokenHash(hash)) ?? (await sessionRepository.findByPreviousTokenHash(hash));
    if (!session) return null;
    await sessionRepository.revoke(session.id, new Date());
    return session.id;
  },

  async logoutSession(sessionId) {
    await sessionRepository.revoke(sessionId, new Date());
  },

  async logoutAll(userId) {
    return sessionRepository.revokeAllForUser(userId, new Date());
  },

  /** Resolve an access token to the authenticated user; throws 401 if the session is gone. */
  async authenticate(accessToken) {
    const { userId, sessionId, expiresAt } = tokenService.verifyAccessToken(accessToken);
    const user = await sessionRepository.findActiveWithUser({ sessionId, userId, now: new Date() });
    if (!user) throw AppError.unauthorized('Session expired, please sign in again');
    return { user: toUser(user), sessionId, expiresAt };
  },
};
