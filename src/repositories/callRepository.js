import { pool } from '../db/pool.js';

const SELECT = `
  SELECT cl.id, cl.conversation_id, cl.caller_id, cl.callee_id, cl.type, cl.is_group, cl.status,
         cl.answered_at, cl.ended_at, cl.ended_by, cl.created_at
    FROM calls cl`;

// Am I in this call's history? One-to-one: caller or callee. Group: I was rung or joined.
const MINE = `(cl.caller_id = ? OR cl.callee_id = ? OR EXISTS (SELECT 1 FROM call_participants mp WHERE mp.call_id = cl.id AND mp.user_id = ?))`;

export const callRepository = {
  async create({ conversationId, callerId, calleeId = null, type, isGroup = false, status = 'ringing', at }) {
    const [result] = await pool.execute(
      `INSERT INTO calls (conversation_id, caller_id, callee_id, type, is_group, status, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [conversationId, callerId, calleeId, type, isGroup ? 1 : 0, status, status === 'ringing' ? null : at, at, at],
    );
    return result.insertId;
  },

  // ---- Group call participants ----

  /** Everyone rung for a group call (the starter joins at once). */
  async invite(callId, userIds, { at, joinedId }) {
    if (userIds.length === 0) return;
    await pool.query('INSERT INTO call_participants (call_id, user_id, invited_at, joined_at) VALUES ?', [
      userIds.map((userId) => [callId, userId, at, userId === joinedId ? at : null]),
    ]);
  },

  /** Joined (again): someone who left and came back keeps their first joined_at. */
  async markJoined(callId, userId, at) {
    await pool.execute(
      `INSERT INTO call_participants (call_id, user_id, invited_at, joined_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE joined_at = COALESCE(joined_at, VALUES(joined_at)), left_at = NULL`,
      [callId, userId, at, at],
    );
  },

  async markLeft(callId, userId, at) {
    await pool.execute('UPDATE call_participants SET left_at = ? WHERE call_id = ? AND user_id = ? AND joined_at IS NOT NULL', [at, callId, userId]);
  },

  async markAllLeft(callId, at) {
    await pool.execute('UPDATE call_participants SET left_at = ? WHERE call_id = ? AND joined_at IS NOT NULL AND left_at IS NULL', [at, callId]);
  },

  /** Who took part in a group call (joined at some point), in joining order. */
  async listJoinedIds(callId) {
    const [rows] = await pool.execute('SELECT user_id FROM call_participants WHERE call_id = ? AND joined_at IS NOT NULL ORDER BY joined_at, user_id', [
      callId,
    ]);
    return rows.map((row) => row.user_id);
  },

  async findById(id) {
    const [rows] = await pool.execute(`${SELECT} WHERE cl.id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  },

  /** ringing → ongoing. False if the call is no longer ringing (cancelled, timed out…). */
  async markAnswered(id, at) {
    const [result] = await pool.execute(
      "UPDATE calls SET status = 'ongoing', answered_at = ? WHERE id = ? AND status = 'ringing'",
      [at, id],
    );
    return result.affectedRows === 1;
  },

  /** Finish a ringing/ongoing call. False if it had already finished. */
  async finish(id, { status, endedBy, at }) {
    const [result] = await pool.execute(
      `UPDATE calls SET status = ?, ended_by = ?, ended_at = ?
        WHERE id = ? AND status IN ('ringing', 'ongoing')`,
      [status, endedBy, at, id],
    );
    return result.affectedRows === 1;
  },

  /** After a restart no call can still be live: close what was left open. */
  async finishStale(at) {
    const [result] = await pool.execute(
      `UPDATE calls SET status = IF(status = 'ringing', 'missed', 'ended'), ended_at = ?
        WHERE status IN ('ringing', 'ongoing')`,
      [at],
    );
    return result.affectedRows;
  },

  /**
   * My call history, newest first: one-to-one calls with the other person's public details,
   * group calls with the group's name and photo and whether I joined.
   */
  async listForUser(userId, { before, limit }) {
    const params = [userId, userId, userId, userId, userId, userId, userId];
    let where = '';
    if (before) {
      where = 'AND cl.id < ?';
      params.push(before);
    }
    params.push(limit);
    const [rows] = await pool.query(
      `SELECT cl.id, cl.conversation_id, cl.caller_id, cl.callee_id, cl.type, cl.is_group, cl.status,
              cl.answered_at, cl.ended_at, cl.created_at,
              u.id AS peer_id, u.name AS peer_name, u.avatar_path AS peer_avatar_path,
              EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = ?) AS peer_blocked_me,
              g.name AS group_name, g.avatar_path AS group_avatar_path,
              cp.joined_at AS my_joined_at
         FROM calls cl
         LEFT JOIN users u ON cl.is_group = 0 AND u.id = IF(cl.caller_id = ?, cl.callee_id, cl.caller_id)
         LEFT JOIN chat_groups g ON cl.is_group = 1 AND g.conversation_id = cl.conversation_id
         LEFT JOIN call_participants cp ON cp.call_id = cl.id AND cp.user_id = ?
        WHERE ${MINE}
          AND cl.status NOT IN ('ringing', 'ongoing')
          AND NOT EXISTS (SELECT 1 FROM call_hidden h WHERE h.call_id = cl.id AND h.user_id = ?)
          ${where}
        ORDER BY cl.id DESC
        LIMIT ?`,
      params,
    );
    return rows;
  },

  async hide(userId, callIds) {
    if (callIds.length === 0) return;
    await pool.query(
      `INSERT IGNORE INTO call_hidden (call_id, user_id)
       SELECT cl.id, ? FROM calls cl WHERE cl.id IN (?) AND ${MINE}`,
      [userId, callIds, userId, userId, userId],
    );
  },

  async hideAll(userId) {
    await pool.query(
      `INSERT IGNORE INTO call_hidden (call_id, user_id)
       SELECT cl.id, ? FROM calls cl WHERE ${MINE} AND cl.status NOT IN ('ringing', 'ongoing')`,
      [userId, userId, userId, userId],
    );
  },
};
