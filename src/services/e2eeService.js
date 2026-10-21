import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { pool, withTransaction } from '../db/pool.js';
import { deviceRepository } from '../repositories/deviceRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { AppError } from '../utils/AppError.js';

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** A device as shown to its owner (Settings → Linked devices). */
export const toDevice = (row, currentDeviceId = null) => ({
  id: row.id,
  name: row.name,
  publicKey: row.public_key,
  fingerprint: row.fingerprint,
  createdAt: iso(row.created_at),
  lastSeenAt: iso(row.last_seen_at),
  current: row.id === currentDeviceId,
});

/** Base64 raw P-256 public key → validated bytes (throws 400 for anything else). */
function parsePublicKey(value) {
  const bytes = Buffer.from(String(value ?? ''), 'base64');
  if (bytes.length !== 65 || bytes[0] !== 0x04) throw AppError.badRequest('Invalid device key');
  try {
    // Throws unless the bytes are a real point on the P-256 curve.
    crypto.ECDH.convertKey(bytes, 'prime256v1', undefined, undefined, 'uncompressed');
  } catch {
    throw AppError.badRequest('Invalid device key');
  }
  return bytes;
}

// Which device a request comes from is checked on every request; cache the answer briefly.
const deviceCache = new Map(); // `${userId}:${deviceId}` -> expiry timestamp
const CACHE_MS = 60_000;

export const e2eeService = {
  /**
   * Register this browser's public key (idempotent for the same key). The first
   * device of an account is silent; later ones post "security code changed" into
   * the user's one-to-one chats, so contacts can re-verify.
   * Returns { device, events: [{ messageId, participantIds }] }.
   */
  async registerDevice(userId, { publicKey, name }) {
    const bytes = parsePublicKey(publicKey);
    const fingerprint = crypto.createHash('sha256').update(bytes).digest('hex');
    const now = new Date();
    const existing = await deviceRepository.findByFingerprint(userId, fingerprint);
    if (existing) {
      // A removed device must make new keys; its old ones may be compromised.
      if (existing.revoked_at) throw new AppError(410, 'DEVICE_REVOKED', 'This device was removed. Set up encryption again.');
      await deviceRepository.touch(existing.id, { name, at: now });
      return { device: toDevice({ ...existing, name, last_seen_at: now }, existing.id), events: [] };
    }
    if ((await deviceRepository.countActive(userId)) >= config.e2ee.maxDevicesPerUser) {
      throw new AppError(409, 'TOO_MANY_DEVICES', `You can use TEMU on up to ${config.e2ee.maxDevicesPerUser} devices. Remove one in Settings → Linked devices.`);
    }
    const hadDevices = await deviceRepository.hasAny(userId);
    const id = await deviceRepository.create({ userId, publicKey: bytes.toString('base64'), fingerprint, name, at: now });
    const events = hadDevices ? await this.recordSecurityChange(userId, now) : [];
    return { device: toDevice(await deviceRepository.findById(id), id), events };
  },

  /** "Ann's security code changed" in each of Ann's one-to-one chats (not moving the chat up). */
  async recordSecurityChange(userId, at) {
    const [rows] = await pool.execute(
      `SELECT c.id, (SELECT u.name FROM users u WHERE u.id = ?) AS name,
              (SELECT op.user_id FROM conversation_participants op WHERE op.conversation_id = c.id AND op.user_id <> ? LIMIT 1) AS partner_id
         FROM conversation_participants p JOIN conversations c ON c.id = p.conversation_id AND c.type = 'direct'
        WHERE p.user_id = ?`,
      [userId, userId, userId],
    );
    const events = [];
    for (const row of rows) {
      const messageId = await withTransaction((connection) =>
        messageRepository.insertEvent(connection, {
          conversationId: row.id,
          actorId: userId,
          type: 'security_code_changed',
          data: { user: { id: userId, name: row.name } },
          at,
        }),
      );
      events.push({ messageId, participantIds: [userId, row.partner_id].filter(Boolean) });
    }
    return events;
  },

  async listDevices(userId, currentDeviceId) {
    return (await deviceRepository.listActive(userId)).map((row) => toDevice(row, currentDeviceId));
  },

  async revokeDevice(userId, deviceId) {
    if (!(await deviceRepository.revoke(userId, deviceId, new Date()))) throw AppError.notFound('Device not found');
    deviceCache.delete(`${userId}:${deviceId}`);
  },

  /** Is `deviceId` an active device of this user? (X-Device-Id header, socket handshake.) */
  async isOwnDevice(userId, deviceId) {
    const key = `${userId}:${deviceId}`;
    if ((deviceCache.get(key) ?? 0) > Date.now()) return true;
    const row = await deviceRepository.findById(deviceId);
    const ok = Boolean(row && row.user_id === userId && !row.revoked_at);
    if (ok) deviceCache.set(key, Date.now() + CACHE_MS);
    else deviceCache.delete(key);
    return ok;
  },

  /** Devices a new message in this conversation must be encrypted for. */
  async devicesForConversation(conversationId) {
    return (await deviceRepository.listForConversation(conversationId)).map((d) => ({ id: d.id, userId: d.user_id, publicKey: d.public_key }));
  },

  /** Devices of these users (safety numbers / "verify security code"). */
  async devicesOfUsers(userIds) {
    return (await deviceRepository.listActiveFor(userIds)).map((d) => ({ id: d.id, userId: d.user_id, publicKey: d.public_key }));
  },

  /**
   * Check an encrypted message before storing it: sent from one of the sender's
   * devices, and its key wrapped for exactly the conversation's current devices.
   * A missing or extra device means the sender's device list is out of date (409).
   */
  async assertEnvelope(senderId, conversationId, encrypted) {
    if (!(await this.isOwnDevice(senderId, encrypted.senderDeviceId))) {
      throw new AppError(403, 'UNKNOWN_DEVICE', 'This device is not set up for encryption');
    }
    const expected = await this.devicesForConversation(conversationId);
    const wanted = new Set(expected.map((d) => d.id));
    const given = encrypted.keys.map((k) => k.deviceId);
    const sameSet = given.length === wanted.size && new Set(given).size === given.length && given.every((id) => wanted.has(id));
    if (!sameSet) {
      throw new AppError(409, 'DEVICES_CHANGED', 'The people in this chat changed devices. Try again.', { devices: expected });
    }
  },

  forgetCache() {
    deviceCache.clear();
  },
};
