import { pool } from '../db/pool.js';
import { escapeLike } from '../utils/text.js';

const COLUMNS = ['id', 'name', 'email', 'email_verified_at', 'about', 'status', 'avatar_path', 'last_seen_at', 'created_at'];

/** Public user columns, optionally prefixed with a table alias (never includes password_hash). */
export function userColumns(alias) {
  return COLUMNS.map((column) => (alias ? `${alias}.${column}` : column)).join(', ');
}

/**
 * How `viewer` (an SQL expression for the viewer's id) relates to the user `alias`.
 * These flags drive every privacy decision (see serializers: profileFields, canSeeEmail):
 * is_contact (I saved them), saved_me (they saved me), is_partner (we have a one-to-one chat),
 * blocked_by_me / blocked_me, and their "last seen & online" setting.
 */
export function relationColumns(alias, viewer) {
  return `
    EXISTS(SELECT 1 FROM contacts r1 WHERE r1.user_id = ${viewer} AND r1.contact_user_id = ${alias}.id) AS is_contact,
    EXISTS(SELECT 1 FROM contacts r2 WHERE r2.user_id = ${alias}.id AND r2.contact_user_id = ${viewer}) AS saved_me,
    EXISTS(SELECT 1 FROM conversations r3
            WHERE r3.direct_key = CONCAT(LEAST(${alias}.id, ${viewer}), ':', GREATEST(${alias}.id, ${viewer}))) AS is_partner,
    EXISTS(SELECT 1 FROM blocks r4 WHERE r4.blocker_id = ${viewer} AND r4.blocked_id = ${alias}.id) AS blocked_by_me,
    EXISTS(SELECT 1 FROM blocks r5 WHERE r5.blocker_id = ${alias}.id AND r5.blocked_id = ${viewer}) AS blocked_me,
    COALESCE((SELECT r6.last_seen_visibility FROM user_settings r6 WHERE r6.user_id = ${alias}.id), 'everyone') AS last_seen_visibility`;
}

export const userRepository = {
  /** Several users at once (public columns), in no particular order. */
  async findManyByIds(ids) {
    if (ids.length === 0) return [];
    const [rows] = await pool.query(`SELECT ${userColumns()} FROM users WHERE id IN (?)`, [ids]);
    return rows;
  },

  async create({ name, email, passwordHash }) {
    const [result] = await pool.execute('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [
      name,
      email,
      passwordHash,
    ]);
    return result.insertId;
  },

  /** Includes password_hash — only for authentication. */
  async findByEmailWithPassword(email) {
    const [rows] = await pool.execute(`SELECT ${userColumns()}, password_hash FROM users WHERE email = ? LIMIT 1`, [email]);
    return rows[0] ?? null;
  },

  async findByEmail(email) {
    const [rows] = await pool.execute(`SELECT ${userColumns()} FROM users WHERE email = ? LIMIT 1`, [email]);
    return rows[0] ?? null;
  },

  async findById(id) {
    const [rows] = await pool.execute(`SELECT ${userColumns()} FROM users WHERE id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  },

  /**
   * A user as seen by `viewerId`, with block flags in both directions.
   * blocked_by_me: viewer blocked them. blocked_me: they blocked the viewer.
   */
  async findForViewer(id, viewerId) {
    const [rows] = await pool.execute(
      `SELECT ${userColumns('u')}, ${relationColumns('u', 'v.viewer_id')},
              EXISTS(SELECT 1 FROM conversation_participants p1
                       JOIN conversation_participants p2 ON p2.conversation_id = p1.conversation_id
                      WHERE p1.user_id = v.viewer_id AND p2.user_id = u.id) AS shares_chat
         FROM (SELECT ? AS viewer_id) v
         JOIN users u ON u.id = ?
        LIMIT 1`,
      [viewerId, id],
    );
    return rows[0] ?? null;
  },

  /**
   * Search other users by name (substring), or by email — only the complete
   * address, so nobody can harvest emails by typing a few letters.
   * Users who blocked the searcher are invisible to them.
   */
  async search({ query, excludeUserId, limit = 20 }) {
    const term = escapeLike(query.toLowerCase());
    const [rows] = await pool.query(
      `SELECT ${userColumns('u')}, ${relationColumns('u', 'v.viewer_id')}
         FROM (SELECT ? AS viewer_id) v
         JOIN users u ON u.id <> v.viewer_id
        WHERE u.email_verified_at IS NOT NULL
          AND (u.name LIKE ? OR u.email = ?)
          AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = v.viewer_id)
        ORDER BY (u.email = ?) DESC, (u.name LIKE ?) DESC, u.name ASC
        LIMIT ?`,
      [excludeUserId, `%${term}%`, query.toLowerCase(), query.toLowerCase(), `${term}%`, limit],
    );
    return rows;
  },

  async updateLastSeen(id, at) {
    await pool.execute('UPDATE users SET last_seen_at = ? WHERE id = ?', [at, id]);
  },

  /** Update only the provided profile fields. */
  async updateProfile(id, fields) {
    // Column names come from this fixed list, never from user input.
    const entries = ['name', 'about', 'status'].filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]);
    if (entries.length === 0) return;
    await pool.execute(`UPDATE users SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`, [
      ...entries.map(([, value]) => value),
      id,
    ]);
  },

  async setAvatarPath(id, avatarPath) {
    await pool.execute('UPDATE users SET avatar_path = ? WHERE id = ?', [avatarPath, id]);
  },

  async markEmailVerified(id, at) {
    await pool.execute('UPDATE users SET email_verified_at = ? WHERE id = ? AND email_verified_at IS NULL', [at, id]);
  },

  async updatePassword(id, passwordHash) {
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  },

  /** Re-registration of a never-verified account: the new registrant gets to set name/password. */
  async resetUnverified(id, { name, passwordHash }) {
    const [result] = await pool.execute(
      'UPDATE users SET name = ?, password_hash = ? WHERE id = ? AND email_verified_at IS NULL',
      [name, passwordHash, id],
    );
    return result.affectedRows === 1;
  },
};
