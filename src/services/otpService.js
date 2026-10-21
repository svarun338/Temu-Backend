import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { otpRepository } from '../repositories/otpRepository.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { mailService } from './mailService.js';

const MAX_CODES_PER_HOUR = 10;
const INVALID_CODE = 'This code is invalid or has expired. Request a new one.';

/** HMAC (not a plain hash): 6-digit codes are too few to resist offline guessing of a leaked hash. */
function hashCode(userId, purpose, code) {
  return crypto.createHmac('sha256', config.auth.accessSecret).update(`${userId}:${purpose}:${code}`).digest('hex');
}

function generateCode() {
  return crypto.randomInt(0, 10 ** config.otp.length).toString().padStart(config.otp.length, '0');
}

export const otpService = {
  /**
   * Create and deliver a new code for `user`.
   * Returns { retryAfterSeconds, devOtp? } — devOtp only when development display is on.
   * Throws 429 while the resend cooldown is running.
   */
  async issue(user, purpose) {
    const now = new Date();
    const { lastCreatedAt, recentCount } = await otpRepository.issueStats(user.id, purpose, new Date(now - 60 * 60 * 1000));
    const cooldownMs = config.otp.resendCooldownSeconds * 1000;
    if (lastCreatedAt && now - new Date(lastCreatedAt) < cooldownMs) {
      const wait = Math.ceil((cooldownMs - (now - new Date(lastCreatedAt))) / 1000);
      throw new AppError(429, 'OTP_COOLDOWN', `Please wait ${wait} seconds before requesting a new code.`, { retryAfterSeconds: wait });
    }
    if (recentCount >= MAX_CODES_PER_HOUR) {
      throw new AppError(429, 'OTP_LIMIT', 'Too many codes requested. Please try again in an hour.');
    }

    const code = generateCode();
    await otpRepository.replace({
      userId: user.id,
      purpose,
      codeHash: hashCode(user.id, purpose, code),
      expiresAt: new Date(now.getTime() + config.otp.ttlMinutes * 60_000),
      at: now,
    });

    try {
      const sent = await mailService.sendOtp({ to: user.email, name: user.name, code, purpose });
      if (!sent && !config.otp.devDisplay) {
        // Production without SMTP: there is no way to deliver the code.
        logger.error('Cannot deliver OTP: SMTP is not configured');
        throw new AppError(503, 'EMAIL_UNAVAILABLE', 'Email delivery is not available right now. Please try again later.');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      logger.error('Sending OTP email failed', { userId: user.id, purpose, error });
      if (!config.otp.devDisplay) {
        throw new AppError(503, 'EMAIL_UNAVAILABLE', 'We could not send the email. Please try again later.');
      }
    }

    return { retryAfterSeconds: config.otp.resendCooldownSeconds, ...(config.otp.devDisplay ? { devOtp: code } : {}) };
  },

  /** Check and consume a code. Throws 400 INVALID_CODE on any failure (wrong, expired, used, too many tries). */
  async consume(user, purpose, code) {
    const now = new Date();
    const otp = await otpRepository.findActive(user.id, purpose, now);
    if (!otp || otp.attempts >= config.otp.maxAttempts) throw new AppError(400, 'INVALID_CODE', INVALID_CODE);

    const expected = Buffer.from(otp.code_hash, 'hex');
    const actual = Buffer.from(hashCode(user.id, purpose, code), 'hex');
    if (!crypto.timingSafeEqual(expected, actual)) {
      const attempts = await otpRepository.recordFailedAttempt(otp.id);
      const left = config.otp.maxAttempts - attempts;
      if (left <= 0) {
        await otpRepository.consume(otp.id, now);
        throw new AppError(400, 'INVALID_CODE', 'Too many wrong attempts. Request a new code.');
      }
      throw new AppError(400, 'INVALID_CODE', `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.`, {
        attemptsLeft: left,
      });
    }
    if (!(await otpRepository.consume(otp.id, now))) throw new AppError(400, 'INVALID_CODE', INVALID_CODE);
  },
};
