import crypto from 'node:crypto';
import { userRepository } from '../repositories/userRepository.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { objectStorage } from './objectStorage.js';
import { toPublicUser, toUser } from './serializers.js';

/** Profile and group photos are stored at avatars/<name> (local disk or S3) and served at /uploads/avatars/<name>. */
const AVATAR_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
export const IMAGE_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/**
 * Identify an image by its first bytes. The client-supplied MIME type and file
 * name are never trusted. GIF/SVG are rejected (animation / script content).
 */
export function detectImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Validate an uploaded image (by its bytes) and store it under a random name. Returns the file name. */
export async function storeAvatarImage(file) {
  if (!file?.buffer?.length) throw AppError.badRequest('Choose an image to upload');
  const type = detectImageType(file.buffer);
  if (!type) throw new AppError(415, 'UNSUPPORTED_FILE', 'Only JPG, PNG or WebP images are allowed');
  const fileName = `${crypto.randomBytes(16).toString('hex')}.${type}`;
  await objectStorage.current.putBuffer(`avatars/${fileName}`, file.buffer, IMAGE_MIME[type]);
  return fileName;
}

export async function deleteAvatarFile(fileName) {
  // Only ever delete names we generated ourselves (no path traversal).
  if (!fileName || !AVATAR_NAME.test(fileName)) return;
  await objectStorage.removeEverywhere(`avatars/${fileName}`).catch((error) => logger.warn('Could not delete old avatar', { error }));
}

export const profileService = {
  async getOwn(userId) {
    const row = await userRepository.findById(userId);
    if (!row) throw AppError.notFound('User not found');
    return toUser(row);
  },

  /**
   * Another user's profile, with privacy rules applied. Only for people I'm
   * connected to (a contact either way, or a shared chat/group), so profiles
   * can't be collected by counting through user ids.
   */
  async getPublic(viewerId, userId) {
    const row = await userRepository.findForViewer(userId, viewerId);
    const connected = row && (Number(row.is_contact) || Number(row.saved_me) || Number(row.shares_chat));
    // Hidden from people they blocked, and unverified accounts don't exist publicly.
    if (!connected || Number(row.blocked_me) || !row.email_verified_at) throw AppError.notFound('User not found');
    return toPublicUser(row);
  },

  async update(userId, fields) {
    await userRepository.updateProfile(userId, fields);
    return this.getOwn(userId);
  },

  /** Store a validated image under a random, unguessable name and replace the old one. */
  async setAvatar(userId, file) {
    const fileName = await storeAvatarImage(file);
    const previous = (await userRepository.findById(userId))?.avatar_path;
    try {
      await userRepository.setAvatarPath(userId, fileName);
    } catch (error) {
      await deleteAvatarFile(fileName);
      throw error;
    }
    await deleteAvatarFile(previous);
    return this.getOwn(userId);
  },

  async removeAvatar(userId) {
    const previous = (await userRepository.findById(userId))?.avatar_path;
    await userRepository.setAvatarPath(userId, null);
    await deleteAvatarFile(previous);
    return this.getOwn(userId);
  },
};
