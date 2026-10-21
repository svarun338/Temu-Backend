import { pool } from '../db/pool.js';

export const otpRepository = {
  /** Store a new code and invalidate any earlier unused code for the same purpose. */
  async replace({ userId, purpose, codeHash, expiresAt, at }) {
    await pool.execute(
      'UPDATE email_otps SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL',
      [at, userId, purpose],
    );
    await pool.execute('INSERT INTO email_otps (user_id, purpose, code_hash, expires_at) VALUES (?, ?, ?, ?)', [
      userId,
      purpose,
      codeHash,
      expiresAt,
    ]);
  },

  /** The current usable code, if any. */
  async findActive(userId, purpose, now) {
    const [rows] = await pool.execute(
      `SELECT id, code_hash, attempts, expires_at FROM email_otps
        WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?
        ORDER BY id DESC LIMIT 1`,
      [userId, purpose, now],
    );
    return rows[0] ?? null;
  },

  /** Count a wrong guess. Returns the new attempt count. */
  async recordFailedAttempt(id) {
    await pool.execute('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?', [id]);
    const [rows] = await pool.execute('SELECT attempts FROM email_otps WHERE id = ?', [id]);
    return rows[0]?.attempts ?? 0;
  },

  /** Mark used. Returns false if it was already used (e.g. a parallel request). */
  async consume(id, at) {
    const [result] = await pool.execute('UPDATE email_otps SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL', [at, id]);
    return result.affectedRows === 1;
  },

  /** Creation time of the newest code and how many were issued since `since`. */
  async issueStats(userId, purpose, since) {
    const [rows] = await pool.execute(
      `SELECT MAX(created_at) AS last_created_at, SUM(created_at >= ?) AS recent_count
         FROM email_otps WHERE user_id = ? AND purpose = ?`,
      [since, userId, purpose],
    );
    return { lastCreatedAt: rows[0]?.last_created_at ?? null, recentCount: Number(rows[0]?.recent_count ?? 0) };
  },

  async deleteExpired(before) {
    await pool.execute('DELETE FROM email_otps WHERE expires_at < ?', [before]);
  },
};
