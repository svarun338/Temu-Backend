import { contactRepository } from '../../repositories/contactRepository.js';
import { conversationRepository } from '../../repositories/conversationRepository.js';
import { blockRepository } from '../../repositories/blockRepository.js';
import { settingsRepository } from '../../repositories/settingsRepository.js';
import { userRepository } from '../../repositories/userRepository.js';
import { messageService } from '../../services/messageService.js';
import { presenceService } from '../../services/presenceService.js';
import { logger } from '../../utils/logger.js';
import { toProfileUpdate } from '../../services/serializers.js';
import { realtime } from '../realtime.js';

// Disconnect bookkeeping still writing to the database.
const pendingDisconnects = new Set();

/**
 * Profile changes are shared with people who saved this user or chat with
 * them — never with anyone on either side of a block.
 */
export async function profileAudience(userId) {
  const [savedBy, partners, blocked] = await Promise.all([
    contactRepository.listUserIdsWhoSaved(userId),
    conversationRepository.listPartnerIds(userId),
    blockRepository.listRelatedIds(userId),
  ]);
  const hidden = new Set(blocked);
  return [...new Set([...savedBy, ...partners])].filter((id) => !hidden.has(id));
}

/**
 * Who gets live "online / last seen" updates: the profile audience, narrowed by
 * the user's "last seen & online" setting (same rule as canSeePresence).
 */
export async function presenceAudience(userId) {
  const [audience, settings] = await Promise.all([profileAudience(userId), settingsRepository.getUserSettings(userId)]);
  const visibility = settings.last_seen_visibility ?? 'everyone';
  if (visibility === 'nobody') return [];
  if (visibility === 'contacts') {
    const saved = new Set(await contactRepository.listContactIds(userId));
    return audience.filter((id) => saved.has(id));
  }
  return audience;
}

async function announce(userId, isOnline, lastSeenAt = null) {
  const audience = await presenceAudience(userId);
  realtime.emitToUsers(audience, 'presence:update', { userId, isOnline, lastSeenAt });
}

/** The "last seen & online" setting changed: show or hide my presence for everyone affected right away. */
export async function announceVisibilityChange(userId) {
  const [everyone, allowed, row] = await Promise.all([profileAudience(userId), presenceAudience(userId), userRepository.findById(userId)]);
  const allowedSet = new Set(allowed);
  const lastSeenAt = row?.last_seen_at ? new Date(row.last_seen_at).toISOString() : null;
  realtime.emitToUsers(allowed, 'presence:update', { userId, isOnline: presenceService.isOnline(userId), lastSeenAt });
  realtime.emitToUsers(
    everyone.filter((id) => !allowedSet.has(id)),
    'presence:update',
    { userId, isOnline: false, lastSeenAt: null },
  );
}

/** Call after `registerPresenceHandlers` (which records the socket synchronously). */
export async function handlePresenceConnect(socket) {
  const userId = socket.data.user.id;
  if (socket.data.cameOnline && socket.connected) {
    await announce(userId, true);
  }
  // Everything queued while the user was offline has now reached a device.
  const receipts = await messageService.markAllPendingDelivered(userId);
  receipts.forEach(realtime.broadcastReceipt);
}

export function registerPresenceHandlers(socket) {
  const userId = socket.data.user.id;
  // Recorded synchronously so a disconnect during async setup can never leave a ghost entry.
  socket.data.cameOnline = presenceService.connect(userId, socket.id);

  socket.on('disconnect', () => {
    const task = handleDisconnect(userId, socket.id);
    pendingDisconnects.add(task);
    task.finally(() => pendingDisconnects.delete(task));
  });
}

async function handleDisconnect(userId, socketId) {
  try {
    if (!presenceService.disconnect(userId, socketId)) return;
    const lastSeenAt = new Date();
    await userRepository.updateLastSeen(userId, lastSeenAt);
    // A new socket may have connected while we were writing.
    if (!presenceService.isOnline(userId)) await announce(userId, false, lastSeenAt.toISOString());
  } catch (error) {
    logger.error('Presence disconnect failed', { userId, error });
  }
}

/** Resolves once every in-flight disconnect handler has finished (call before closing the pool). */
export async function settlePresence() {
  while (pendingDisconnects.size > 0) await Promise.allSettled([...pendingDisconnects]);
}

/** Push a user's new name/photo/about/status to everyone who can see them, and to their own other tabs. */
export async function announceProfileChange(user) {
  const row = await userRepository.findById(user.id);
  if (!row) return;
  realtime.emitToUsers(await profileAudience(user.id), 'user:updated', toProfileUpdate(row));
  realtime.emitToUsers([user.id], 'profile:updated', user);
}

/**
 * After `blockerId` blocks (or unblocks) `blockedId`, update both sides live:
 * the blocker's other tabs learn the new state, and each side's view of the
 * other's presence/profile is hidden or restored.
 */
export async function announceBlockChange(blockerId, blockedId, blocked) {
  realtime.emitToUsers([blockerId], 'block:updated', { userId: blockedId, blocked });

  const [blockerRow, blockedRow] = await Promise.all([userRepository.findById(blockerId), userRepository.findById(blockedId)]);
  if (!blockerRow || !blockedRow) return;
  // An unblock only restores visibility if no block remains in the other direction.
  const stillHidden = blocked || (await blockRepository.existsBetween(blockerId, blockedId));

  const presenceOf = (row) =>
    stillHidden
      ? { userId: row.id, isOnline: false, lastSeenAt: null }
      : { userId: row.id, isOnline: presenceService.isOnline(row.id), lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null };

  realtime.emitToUsers([blockedId], 'presence:update', presenceOf(blockerRow));
  realtime.emitToUsers([blockerId], 'presence:update', presenceOf(blockedRow));
  realtime.emitToUsers([blockedId], 'user:updated', toProfileUpdate(blockerRow, { hidden: stillHidden }));
}
