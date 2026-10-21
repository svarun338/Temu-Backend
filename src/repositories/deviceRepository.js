import { pool } from '../db/pool.js';

const COLUMNS = 'id, user_id, public_key, fingerprint, name, last_seen_at, revoked_at, created_at';

/** Device public keys for end-to-end encryption (one row per browser/device). */
export const deviceRepository = {
  async findByFingerprint(userId, fingerprint) {
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM user_devices WHERE user_id = ? AND fingerprint = ? LIMIT 1`, [userId, fingerprint]);
    return rows[0] ?? null;
  },

  async findById(id) {
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM user_devices WHERE id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  },

  async create({ userId, publicKey, fingerprint, name, at }) {
    const [result] = await pool.execute(
      'INSERT INTO user_devices (user_id, public_key, fingerprint, name, last_seen_at) VALUES (?, ?, ?, ?, ?)',
      [userId, publicKey, fingerprint, name, at],
    );
    return result.insertId;
  },

  /** The same browser registering again (e.g. after signing in again). */
  async touch(id, { name, at }) {
    await pool.execute('UPDATE user_devices SET name = ?, last_seen_at = ? WHERE id = ?', [name, at, id]);
  },

  async listActive(userId) {
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM user_devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY id`, [userId]);
    return rows;
  },

  async countActive(userId) {
    const [[row]] = await pool.execute('SELECT COUNT(*) AS n FROM user_devices WHERE user_id = ? AND revoked_at IS NULL', [userId]);
    return Number(row.n);
  },

  /** Has this user ever had a device (also revoked ones)? */
  async hasAny(userId) {
    const [rows] = await pool.execute('SELECT 1 FROM user_devices WHERE user_id = ? LIMIT 1', [userId]);
    return rows.length > 0;
  },

  async revoke(userId, id, at) {
    const [result] = await pool.execute('UPDATE user_devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [
      at,
      id,
      userId,
    ]);
    return result.affectedRows > 0;
  },

  /** Active devices of everyone in a conversation (who must be able to read a new message). */
  async listForConversation(conversationId) {
    const [rows] = await pool.execute(
      `SELECT d.id, d.user_id, d.public_key
         FROM conversation_participants p
         JOIN user_devices d ON d.user_id = p.user_id AND d.revoked_at IS NULL
        WHERE p.conversation_id = ?
        ORDER BY d.id`,
      [conversationId],
    );
    return rows;
  },

  /** Active devices of several users (safety numbers). */
  async listActiveFor(userIds) {
    if (userIds.length === 0) return [];
    const [rows] = await pool.query(
      `SELECT ${COLUMNS} FROM user_devices WHERE user_id IN (?) AND revoked_at IS NULL ORDER BY user_id, id`,
      [userIds],
    );
    return rows;
  },
};
