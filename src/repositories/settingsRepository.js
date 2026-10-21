import { pool } from '../db/pool.js';

const USER_DEFAULTS = {
  notifications_enabled: 1,
  message_preview: 1,
  sound_enabled: 1,
  last_seen_visibility: 'everyone',
  theme: 'system',
  accent: 'indigo',
  font_size: 'medium',
  bubble_style: 'rounded',
  default_wallpaper: null,
};
const USER_FIELDS = Object.keys(USER_DEFAULTS);
const BOOLEAN_FIELDS = new Set(['notifications_enabled', 'message_preview', 'sound_enabled']);

export const settingsRepository = {
  /** A user's preferences (defaults when they never changed anything). */
  async getUserSettings(userId) {
    const [rows] = await pool.execute(`SELECT ${USER_FIELDS.join(', ')} FROM user_settings WHERE user_id = ?`, [userId]);
    return rows[0] ?? { ...USER_DEFAULTS };
  },

  /** Preferences of several users at once: Map userId -> settings. */
  async getUserSettingsMany(userIds) {
    const result = new Map(userIds.map((id) => [id, { ...USER_DEFAULTS }]));
    if (userIds.length === 0) return result;
    const [rows] = await pool.query(`SELECT user_id, ${USER_FIELDS.join(', ')} FROM user_settings WHERE user_id IN (?)`, [userIds]);
    for (const row of rows) result.set(row.user_id, row);
    return result;
  },

  /** Upsert only the given fields (column names come from the fixed list above, never from input). */
  async updateUserSettings(userId, fields) {
    const entries = USER_FIELDS.filter((key) => fields[key] !== undefined).map((key) => [
      key,
      BOOLEAN_FIELDS.has(key) ? (fields[key] ? 1 : 0) : fields[key],
    ]);
    if (entries.length === 0) return;
    const columns = entries.map(([key]) => key);
    await pool.execute(
      `INSERT INTO user_settings (user_id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${columns.map((c) => `${c} = VALUES(${c})`).join(', ')}`,
      [userId, ...entries.map(([, value]) => value)],
    );
  },

  async setMutedUntil(userId, conversationId, mutedUntil) {
    await pool.execute(
      `INSERT INTO chat_settings (user_id, conversation_id, muted_until) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE muted_until = VALUES(muted_until)`,
      [userId, conversationId, mutedUntil],
    );
  },

  async setChatWallpaper(userId, conversationId, wallpaper) {
    await pool.execute(
      `INSERT INTO chat_settings (user_id, conversation_id, wallpaper) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE wallpaper = VALUES(wallpaper)`,
      [userId, conversationId, wallpaper],
    );
  },

  /** A deleted custom wallpaper falls back to the default everywhere it was used. */
  async clearWallpaperEverywhere(userId, value) {
    await pool.execute('UPDATE chat_settings SET wallpaper = NULL WHERE user_id = ? AND wallpaper = ?', [userId, value]);
    await pool.execute('UPDATE user_settings SET default_wallpaper = NULL WHERE user_id = ? AND default_wallpaper = ?', [userId, value]);
  },

  /** Map userId -> muted_until for one conversation. */
  async mutedUntilFor(conversationId, userIds) {
    const result = new Map();
    if (userIds.length === 0) return result;
    const [rows] = await pool.query(
      'SELECT user_id, muted_until FROM chat_settings WHERE conversation_id = ? AND user_id IN (?) AND muted_until IS NOT NULL',
      [conversationId, userIds],
    );
    for (const row of rows) result.set(row.user_id, row.muted_until);
    return result;
  },
};
