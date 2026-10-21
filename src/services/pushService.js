import webpush from 'web-push';
import { config } from '../config/index.js';
import { pushRepository } from '../repositories/pushRepository.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';

let configured = false;
function ensureConfigured() {
  if (!config.push.enabled) return false;
  if (!configured) {
    webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
    configured = true;
  }
  return true;
}

/** Chrome/Edge/Opera (FCM), Firefox (Mozilla), Safari (Apple), Windows (WNS). */
export const PUSH_SERVICE_HOSTS =
  /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

/** Web Push: notifications delivered by the browser's push service even when TEMU is closed. */
export const pushService = {
  async subscribe(userId, sessionId, { endpoint, keys }, userAgent) {
    if (!config.push.enabled) throw new AppError(503, 'PUSH_DISABLED', 'Push notifications are not set up on this server');
    const url = new URL(endpoint);
    // Only real browser push services: the server must never be made to call internal or arbitrary hosts.
    if (url.protocol !== 'https:' || url.port !== '' || !PUSH_SERVICE_HOSTS.test(url.hostname)) {
      throw AppError.badRequest('Invalid push endpoint');
    }
    await pushRepository.upsert({ userId, sessionId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent?.slice(0, 255) });
  },

  async unsubscribe(userId, endpoint) {
    await pushRepository.removeByEndpoint(userId, endpoint);
  },

  /** Logging out stops notifications on those devices. */
  async removeForSessions(sessionIds) {
    await pushRepository.removeForSessions(sessionIds);
  },

  /**
   * Send to every device of a user. Expired subscriptions (404/410) are removed.
   * Never throws: notifications are best-effort.
   */
  async sendToUser(userId, payload) {
    if (!ensureConfigured()) return 0;
    const now = new Date();
    const subscriptions = await pushRepository.listActiveForUser(userId, now);
    let sent = 0;
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
            { TTL: 60 * 60, urgency: 'high', topic: payload.tag?.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '') || undefined },
          );
          sent += 1;
          await pushRepository.touch(sub.id, now);
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) await pushRepository.removeById(sub.id);
          else logger.warn('Push delivery failed', { userId, status: error.statusCode });
        }
      }),
    );
    return sent;
  },
};
