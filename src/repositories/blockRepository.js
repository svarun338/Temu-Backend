import { pool } from '../db/pool.js';
import { relationColumns, userColumns } from './userRepository.js';

export const blockRepository = {
  /** Idempotent. Returns true if a new block was created. */
  async block(blockerId, blockedId) {
    const [result] = await pool.execute('INSERT IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)', [
      blockerId,
      blockedId,
    ]);
    return result.affectedRows === 1;
  },

  async unblock(blockerId, blockedId) {
    const [result] = await pool.execute('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [blockerId, blockedId]);
    return result.affectedRows > 0;
  },

  /** Users that `blockerId` has blocked, newest first. */
  async listBlockedBy(blockerId) {
    const [rows] = await pool.execute(
      `SELECT ${userColumns('u')}, b.created_at AS blocked_at, ${relationColumns('u', 'b.blocker_id')}
         FROM blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ?
        ORDER BY b.created_at DESC`,
      [blockerId],
    );
    return rows;
  },

  /** True if either user has blocked the other. */
  async existsBetween(userA, userB) {
    const [rows] = await pool.execute(
      `SELECT 1 FROM blocks
        WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
        LIMIT 1`,
      [userA, userB, userB, userA],
    );
    return rows.length > 0;
  },

  /** { blockedByMe, blockedMe } between `me` and `other`. */
  async relation(me, other) {
    const [rows] = await pool.execute(
      `SELECT EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?) AS blocked_by_me,
              EXISTS(SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?) AS blocked_me`,
      [me, other, other, me],
    );
    return { blockedByMe: Boolean(rows[0].blocked_by_me), blockedMe: Boolean(rows[0].blocked_me) };
  },

  /** Everyone in a block relationship with `userId`, in either direction. */
  async listRelatedIds(userId) {
    const [rows] = await pool.execute(
      `SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?
       UNION
       SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?`,
      [userId, userId],
    );
    return rows.map((row) => row.id);
  },
};
