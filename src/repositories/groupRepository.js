import { pool } from '../db/pool.js';
import { relationColumns, userColumns } from './userRepository.js';

const GROUP_COLUMNS = 'conversation_id, name, description, avatar_path, invite_code, send_permission, edit_permission, created_by, created_at';

export const groupRepository = {
  async create(connection, { conversationId, name, description, createdBy }) {
    await connection.execute('INSERT INTO chat_groups (conversation_id, name, description, created_by) VALUES (?, ?, ?, ?)', [
      conversationId,
      name,
      description ?? null,
      createdBy,
    ]);
  },

  async find(conversationId) {
    const [rows] = await pool.execute(`SELECT ${GROUP_COLUMNS} FROM chat_groups WHERE conversation_id = ? LIMIT 1`, [conversationId]);
    return rows[0] ?? null;
  },

  async findByInviteCode(code) {
    const [rows] = await pool.execute(`SELECT ${GROUP_COLUMNS} FROM chat_groups WHERE invite_code = ? LIMIT 1`, [code]);
    return rows[0] ?? null;
  },

  /** Update only the given fields (column names from a fixed list). */
  async update(conversationId, fields) {
    const allowed = ['name', 'description', 'avatar_path', 'invite_code', 'send_permission', 'edit_permission'];
    const entries = allowed.filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]);
    if (entries.length === 0) return;
    await pool.execute(`UPDATE chat_groups SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE conversation_id = ?`, [
      ...entries.map(([, value]) => value),
      conversationId,
    ]);
  },

  /** Members with their profile and role: owner first, then admins, then by name. */
  /** Members with their relation to `viewerId` (privacy: email / online status / photo). */
  async listMembers(conversationId, viewerId) {
    const [rows] = await pool.execute(
      `SELECT ${userColumns('u')}, p.role, p.joined_at, p.added_by, ${relationColumns('u', 'v.viewer_id')}
         FROM (SELECT ? AS viewer_id) v
         JOIN conversation_participants p ON p.conversation_id = ?
         JOIN users u ON u.id = p.user_id
        ORDER BY FIELD(p.role, 'owner', 'admin', 'member'), u.name`,
      [viewerId ?? 0, conversationId],
    );
    return rows;
  },

  async role(conversationId, userId) {
    const [rows] = await pool.execute('SELECT role FROM conversation_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1', [
      conversationId,
      userId,
    ]);
    return rows[0]?.role ?? null;
  },

  async countMembers(conversationId, connection = pool) {
    const [rows] = await connection.execute('SELECT COUNT(*) AS n FROM conversation_participants WHERE conversation_id = ?', [conversationId]);
    return Number(rows[0].n);
  },

  /**
   * Add members (ignoring people already in). New members start "caught up"
   * to `upToMessageId`, so earlier messages don't count as unread or block receipts.
   * Returns the ids actually added.
   */
  async addMembers(connection, { conversationId, userIds, role = 'member', addedBy, upToMessageId = null }) {
    const added = [];
    for (const userId of userIds) {
      const [result] = await connection.execute(
        `INSERT IGNORE INTO conversation_participants
           (conversation_id, user_id, role, added_by, last_read_message_id, last_delivered_message_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [conversationId, userId, role, addedBy, upToMessageId, upToMessageId],
      );
      if (result.affectedRows === 1) added.push(userId);
    }
    return added;
  },

  async removeMember(connection, conversationId, userId) {
    const [result] = await connection.execute('DELETE FROM conversation_participants WHERE conversation_id = ? AND user_id = ?', [
      conversationId,
      userId,
    ]);
    return result.affectedRows > 0;
  },

  async setRole(conversationId, userId, role, connection = pool) {
    await connection.execute('UPDATE conversation_participants SET role = ? WHERE conversation_id = ? AND user_id = ?', [
      role,
      conversationId,
      userId,
    ]);
  },

  /** Who becomes owner when the owner leaves: the longest-serving admin, else the longest-serving member. */
  async nextOwner(connection, conversationId) {
    const [rows] = await connection.execute(
      `SELECT user_id FROM conversation_participants
        WHERE conversation_id = ? AND role <> 'owner'
        ORDER BY FIELD(role, 'admin', 'member'), joined_at, id
        LIMIT 1`,
      [conversationId],
    );
    return rows[0]?.user_id ?? null;
  },
};
