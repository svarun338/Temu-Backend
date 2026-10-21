import { pool } from '../db/pool.js';

const COLUMNS = 'id, user_id, storage_key, mime_type, size_bytes, width, height, created_at';

/** "My stickers": images a user made or saved; files are shared storage, never copied. */
export const stickerRepository = {
  async list(userId) {
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM user_stickers WHERE user_id = ? ORDER BY id DESC`, [userId]);
    return rows;
  },

  async count(userId) {
    const [[row]] = await pool.execute('SELECT COUNT(*) AS n FROM user_stickers WHERE user_id = ?', [userId]);
    return Number(row.n);
  },

  async find(userId, id) {
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM user_stickers WHERE id = ? AND user_id = ? LIMIT 1`, [id, userId]);
    return rows[0] ?? null;
  },

  /** Idempotent per (user, file): saving the same sticker twice keeps one. Returns the row. */
  async add({ userId, storageKey, mimeType, sizeBytes, width, height }) {
    await pool.execute(
      `INSERT IGNORE INTO user_stickers (user_id, storage_key, mime_type, size_bytes, width, height)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, storageKey, mimeType, sizeBytes, width ?? null, height ?? null],
    );
    const [rows] = await pool.execute(`SELECT ${COLUMNS} FROM user_stickers WHERE user_id = ? AND storage_key = ? LIMIT 1`, [userId, storageKey]);
    return rows[0];
  },

  async remove(userId, id) {
    const [result] = await pool.execute('DELETE FROM user_stickers WHERE id = ? AND user_id = ?', [id, userId]);
    return result.affectedRows > 0;
  },

  async keysForUser(userId) {
    const [rows] = await pool.execute('SELECT storage_key FROM user_stickers WHERE user_id = ?', [userId]);
    return rows.map((row) => row.storage_key);
  },
};
