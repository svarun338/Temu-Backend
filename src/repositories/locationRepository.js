import { pool } from '../db/pool.js';

const COLUMNS = 'message_id, latitude, longitude, accuracy_m, cipher, cipher_iv, is_live, live_until, stopped_at, updated_at';

export const locationRepository = {
  /** `cipher`/`cipherIv`: an encrypted live location (no coordinates stored in the clear). */
  async insert(connection, { messageId, latitude = null, longitude = null, accuracy, cipher = null, cipherIv = null, liveUntil }) {
    await connection.execute(
      `INSERT INTO message_locations (message_id, latitude, longitude, accuracy_m, cipher, cipher_iv, is_live, live_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [messageId, latitude, longitude, accuracy ?? null, cipher, cipherIv, liveUntil ? 1 : 0, liveUntil ?? null],
    );
  },

  /** Move an encrypted live location (only while it is live). */
  async updateCipher({ messageId, cipher, cipherIv, now }) {
    const [result] = await pool.execute(
      `UPDATE message_locations SET cipher = ?, cipher_iv = ?
        WHERE message_id = ? AND cipher IS NOT NULL AND is_live = 1 AND stopped_at IS NULL AND live_until > ?`,
      [cipher, cipherIv, messageId, now],
    );
    return result.affectedRows === 1;
  },

  async findByMessageId(messageId) {
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM message_locations WHERE message_id = ? LIMIT 1`, [messageId]);
    return rows[0] ?? null;
  },

  /** Map of messageId -> row. */
  async listFor(messageIds) {
    const result = new Map();
    if (messageIds.length === 0) return result;
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM message_locations WHERE message_id IN (?)`, [messageIds]);
    for (const row of rows) result.set(row.message_id, row);
    return result;
  },

  /** Move a live location. Only succeeds while it is still live (not stopped, not expired). */
  async updatePosition({ messageId, latitude, longitude, accuracy, now }) {
    const [result] = await pool.execute(
      `UPDATE message_locations SET latitude = ?, longitude = ?, accuracy_m = ?
        WHERE message_id = ? AND cipher IS NULL AND is_live = 1 AND stopped_at IS NULL AND live_until > ?`,
      [latitude, longitude, accuracy ?? null, messageId, now],
    );
    return result.affectedRows === 1;
  },

  async stop(messageId, now) {
    const [result] = await pool.execute(
      'UPDATE message_locations SET stopped_at = ? WHERE message_id = ? AND is_live = 1 AND stopped_at IS NULL AND live_until > ?',
      [now, messageId, now],
    );
    return result.affectedRows === 1;
  },

  async deleteForMessage(connection, messageId) {
    await connection.execute('DELETE FROM message_locations WHERE message_id = ?', [messageId]);
  },

  /** A user's live locations that are still running, in chats they still belong to. */
  async listActiveForSender(userId, now) {
    const [rows] = await pool.execute(
      `SELECT l.message_id, l.live_until, m.conversation_id
         FROM message_locations l
         JOIN messages m ON m.id = l.message_id
         JOIN conversation_participants p ON p.conversation_id = m.conversation_id AND p.user_id = m.sender_id
        WHERE m.sender_id = ? AND m.deleted_at IS NULL
          AND l.is_live = 1 AND l.stopped_at IS NULL AND l.live_until > ?`,
      [userId, now],
    );
    return rows;
  },
};
