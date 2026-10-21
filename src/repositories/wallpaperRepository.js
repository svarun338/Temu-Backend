import { pool } from '../db/pool.js';

export const wallpaperRepository = {
  async create(userId, fileName) {
    const [result] = await pool.execute('INSERT INTO user_wallpapers (user_id, file_name) VALUES (?, ?)', [userId, fileName]);
    return result.insertId;
  },

  async listForUser(userId) {
    const [rows] = await pool.execute('SELECT id, file_name, created_at FROM user_wallpapers WHERE user_id = ? ORDER BY id DESC', [userId]);
    return rows;
  },

  async countForUser(userId) {
    const [rows] = await pool.execute('SELECT COUNT(*) AS n FROM user_wallpapers WHERE user_id = ?', [userId]);
    return Number(rows[0].n);
  },

  /** Only the owner's wallpaper (anything else looks like "not found"). */
  async findOwned(userId, id) {
    const [rows] = await pool.execute('SELECT id, file_name FROM user_wallpapers WHERE id = ? AND user_id = ?', [id, userId]);
    return rows[0] ?? null;
  },

  async delete(id) {
    await pool.execute('DELETE FROM user_wallpapers WHERE id = ?', [id]);
  },
};
