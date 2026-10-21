import crypto from 'node:crypto';
import { pool } from '../db/pool.js';

const hash = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex');

export const pushRepository = {
  /** Save (or move to this user/session) a browser's push subscription. */
  async upsert({ userId, sessionId, endpoint, p256dh, auth, userAgent }) {
    await pool.execute(
      `INSERT INTO push_subscriptions (user_id, session_id, endpoint, endpoint_hash, p256dh, auth, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), session_id = VALUES(session_id), endpoint = VALUES(endpoint),
                               p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent)`,
      [userId, sessionId, endpoint, hash(endpoint), p256dh, auth, userAgent ?? null],
    );
  },

  async removeByEndpoint(userId, endpoint) {
    await pool.execute('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?', [userId, hash(endpoint)]);
  },

  async removeById(id) {
    await pool.execute('DELETE FROM push_subscriptions WHERE id = ?', [id]);
  },

  async removeForSessions(sessionIds) {
    if (sessionIds.length === 0) return;
    await pool.query('DELETE FROM push_subscriptions WHERE session_id IN (?)', [sessionIds]);
  },

  /** Subscriptions whose login session is still active. */
  async listActiveForUser(userId, now) {
    const [rows] = await pool.execute(
      `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
         FROM push_subscriptions ps
         JOIN sessions s ON s.id = ps.session_id
        WHERE ps.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
      [userId, now],
    );
    return rows;
  },

  async touch(id, at) {
    await pool.execute('UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?', [at, id]);
  },
};
