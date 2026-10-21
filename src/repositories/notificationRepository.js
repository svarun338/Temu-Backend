import { pool } from '../db/pool.js';

export const notificationRepository = {
  async create({ userId, type, actorId, conversationId = null, messageId = null }) {
    const [result] = await pool.execute(
      'INSERT INTO notifications (user_id, type, actor_id, conversation_id, message_id) VALUES (?, ?, ?, ?, ?)',
      [userId, type, actorId, conversationId, messageId],
    );
    return result.insertId;
  },

  /** Newest first, with the actor's name/photo and a short message preview. */
  async list(userId, { before, limit = 30 }) {
    const params = [userId];
    let range = '';
    if (before) {
      range = 'AND n.id < ?';
      params.push(before);
    }
    params.push(limit);
    const [rows] = await pool.query(
      `SELECT n.id, n.type, n.actor_id, n.conversation_id, n.message_id, n.read_at, n.created_at,
              u.name AS actor_name, u.avatar_path AS actor_avatar_path,
              IF(m.deleted_at IS NULL, m.body, NULL) AS message_body
         FROM notifications n
         LEFT JOIN users u ON u.id = n.actor_id
         LEFT JOIN messages m ON m.id = n.message_id
        WHERE n.user_id = ?
          -- Hide notifications from people the user has blocked (or who blocked them).
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
             WHERE (b.blocker_id = n.user_id AND b.blocked_id = n.actor_id) OR (b.blocker_id = n.actor_id AND b.blocked_id = n.user_id))
          ${range}
        ORDER BY n.id DESC
        LIMIT ?`,
      params,
    );
    return rows;
  },

  async countUnread(userId) {
    const [rows] = await pool.execute('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId]);
    return Number(rows[0].n);
  },

  /** Mark some (ids) or all of a user's notifications read. */
  async markRead(userId, ids, at) {
    if (ids?.length) {
      await pool.query('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id IN (?) AND read_at IS NULL', [at, userId, ids]);
    } else {
      await pool.execute('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [at, userId]);
    }
  },
};
