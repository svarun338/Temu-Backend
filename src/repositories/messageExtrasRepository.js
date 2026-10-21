import { pool } from '../db/pool.js';

/** Reactions, stars and pins: data attached to messages. */

export const reactionRepository = {
  /** Set (or replace) the user's reaction on a message. */
  async set(messageId, userId, emoji) {
    await pool.execute(
      `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE emoji = VALUES(emoji)`,
      [messageId, userId, emoji],
    );
  },

  async remove(messageId, userId) {
    await pool.execute('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?', [messageId, userId]);
  },

  /** Map of messageId -> [{ emoji, userId }] in reaction order. */
  async listFor(messageIds) {
    const result = new Map();
    if (messageIds.length === 0) return result;
    const [rows] = await pool.query(
      'SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id IN (?) ORDER BY id ASC',
      [messageIds],
    );
    for (const row of rows) {
      if (!result.has(row.message_id)) result.set(row.message_id, []);
      result.get(row.message_id).push({ emoji: row.emoji, userId: row.user_id });
    }
    return result;
  },
};

export const starRepository = {
  async add(messageId, userId) {
    await pool.execute('INSERT IGNORE INTO message_stars (message_id, user_id) VALUES (?, ?)', [messageId, userId]);
  },

  async remove(messageId, userId) {
    await pool.execute('DELETE FROM message_stars WHERE message_id = ? AND user_id = ?', [messageId, userId]);
  },

  /** Which of `messageIds` the user starred. */
  async starredAmong(userId, messageIds) {
    if (messageIds.length === 0) return new Set();
    const [rows] = await pool.query('SELECT message_id FROM message_stars WHERE user_id = ? AND message_id IN (?)', [
      userId,
      messageIds,
    ]);
    return new Set(rows.map((row) => row.message_id));
  },

  /** The user's starred messages (still visible to them), newest star first. */
  async list(userId, limit = 200) {
    const [rows] = await pool.query(
      `SELECT m.id, m.conversation_id, m.sender_id, m.client_id, m.body, m.reply_to_id, m.forwarded,
              m.edited_at, m.deleted_at, m.created_at, m.delivered_at, m.read_at, s.created_at AS starred_at,
              (SELECT su.name FROM users su WHERE su.id = m.sender_id) AS sender_name
         FROM message_stars s
         JOIN messages m ON m.id = s.message_id
         JOIN conversation_participants p ON p.conversation_id = m.conversation_id AND p.user_id = s.user_id
        WHERE s.user_id = ?
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = s.user_id)
        ORDER BY s.created_at DESC
        LIMIT ?`,
      [userId, limit],
    );
    return rows;
  },
};

export const pinRepository = {
  /** Returns false if it was already pinned. */
  async add(connection, { conversationId, messageId, userId }) {
    const [result] = await connection.execute(
      'INSERT IGNORE INTO conversation_pins (conversation_id, message_id, pinned_by) VALUES (?, ?, ?)',
      [conversationId, messageId, userId],
    );
    return result.affectedRows === 1;
  },

  async remove(conversationId, messageId) {
    const [result] = await pool.execute('DELETE FROM conversation_pins WHERE conversation_id = ? AND message_id = ?', [
      conversationId,
      messageId,
    ]);
    return result.affectedRows > 0;
  },

  /** Locks the conversation's pins so concurrent pins can't exceed the limit. */
  async countForUpdate(connection, conversationId) {
    const [rows] = await connection.execute(
      'SELECT COUNT(*) AS n FROM conversation_pins WHERE conversation_id = ? FOR UPDATE',
      [conversationId],
    );
    return Number(rows[0].n);
  },

  /** Oldest pin of a conversation (replaced when the limit is reached). */
  async oldest(connection, conversationId) {
    const [rows] = await connection.execute(
      'SELECT message_id FROM conversation_pins WHERE conversation_id = ? ORDER BY created_at ASC, id ASC LIMIT 1',
      [conversationId],
    );
    return rows[0]?.message_id ?? null;
  },

  async removeWith(connection, conversationId, messageId) {
    await connection.execute('DELETE FROM conversation_pins WHERE conversation_id = ? AND message_id = ?', [conversationId, messageId]);
  },

  /** Pins with their messages, newest pin first. */
  async list(conversationId) {
    const [rows] = await pool.execute(
      `SELECT cp.message_id, cp.pinned_by, cp.created_at AS pinned_at,
              m.sender_id, m.body, m.sticker, m.created_at, m.deleted_at,
              m.encrypted, m.ciphertext, m.cipher_iv, m.sender_device_id,
              (SELECT sd.public_key FROM user_devices sd WHERE sd.id = m.sender_device_id) AS sender_device_key,
              (SELECT su.name FROM users su WHERE su.id = m.sender_id) AS sender_name,
              (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS attachment_count,
              (SELECT CONCAT(a.kind, ':', COALESCE(a.duration_ms, ''), ':', a.original_name)
                 FROM attachments a WHERE a.message_id = m.id ORDER BY a.id LIMIT 1) AS first_attachment,
              (SELECT IF(l.is_live, 'live', 'static') FROM message_locations l WHERE l.message_id = m.id) AS location_kind
         FROM conversation_pins cp
         JOIN messages m ON m.id = cp.message_id
        WHERE cp.conversation_id = ?
        ORDER BY cp.created_at DESC, cp.id DESC`,
      [conversationId],
    );
    return rows;
  },
};
