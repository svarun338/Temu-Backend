import nodemailer from 'nodemailer';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

let transporter = null;

function getTransporter() {
  if (!config.mail.host) return null;
  transporter ??= nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password } : undefined,
  });
  return transporter;
}

const SUBJECTS = {
  verify_email: 'Your TEMU verification code',
  reset_password: 'Your TEMU password reset code',
};

const INTROS = {
  verify_email: 'Use this code to verify your email address:',
  reset_password: 'Use this code to reset your password:',
};

export const mailService = {
  isConfigured: () => Boolean(config.mail.host),

  /**
   * Email a one-time code. Returns true if an email was sent, false if no SMTP
   * server is configured (development). Throws if sending failed.
   */
  async sendOtp({ to, name, code, purpose }) {
    const transport = getTransporter();
    if (!transport) return false;
    const minutes = config.otp.ttlMinutes;
    const text = `Hi ${name},\n\n${INTROS[purpose]}\n\n${code}\n\nIt expires in ${minutes} minutes. If you did not request this, you can ignore this email.`;
    const html = `<p>Hi ${escapeHtml(name)},</p><p>${INTROS[purpose]}</p>
      <p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>
      <p>It expires in ${minutes} minutes. If you did not request this, you can ignore this email.</p>`;
    await transport.sendMail({ from: config.mail.from, to, subject: SUBJECTS[purpose], text, html });
    logger.info('OTP email sent', { purpose });
    return true;
  },
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
