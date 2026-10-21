import { pool } from '../db/pool.js';
import { userColumns } from './userRepository.js';

export const sessionRepository = {
  async create({ userId, tokenHash, userAgent, ipAddress, expiresAt }) {
    const [result] = await pool.execute(
      `INSERT INTO sessions (user_id, token_hash, user_agent, ip_address, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, tokenHash, userAgent, ipAddress, expiresAt],
    );
    return result.insertId;
  },

  async findByTokenHash(tokenHash) {
    const [rows] = await pool.execute('SELECT * FROM sessions WHERE token_hash = ? LIMIT 1', [tokenHash]);
    return rows[0] ?? null;
  },

  async findByPreviousTokenHash(tokenHash) {
    const [rows] = await pool.execute('SELECT * FROM sessions WHERE previous_token_hash = ? LIMIT 1', [tokenHash]);
    return rows[0] ?? null;
  },

  /**
   * Atomically swap the refresh token. Returns false if another request rotated it first.
   */
  async rotate({ id, currentHash, newHash, expiresAt, at }) {
    const [result] = await pool.execute(
      `UPDATE sessions
          SET previous_token_hash = token_hash, token_hash = ?, rotated_at = ?, expires_at = ?
        WHERE id = ? AND token_hash = ? AND revoked_at IS NULL`,
      [newHash, at, expiresAt, id, currentHash],
    );
    return result.affectedRows === 1;
  },

  /** Active session joined with its user — used to authenticate every request. */
  async findActiveWithUser({ sessionId, userId, now }) {
    const [rows] = await pool.execute(
      `SELECT ${userColumns('u')}
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        LIMIT 1`,
      [sessionId, userId, now],
    );
    return rows[0] ?? null;
  },

  async revoke(id, at) {
    await pool.execute('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [at, id]);
  },

  async revokeAllForUser(userId, at) {
    const [rows] = await pool.execute('SELECT id FROM sessions WHERE user_id = ? AND revoked_at IS NULL', [userId]);
    await pool.execute('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [at, userId]);
    return rows.map((row) => row.id);
  },

  async deleteExpired(before) {
    await pool.execute('DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?', [before, before]);
  },
};
