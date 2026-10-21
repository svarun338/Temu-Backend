import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { attachmentRepository } from '../repositories/attachmentRepository.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { stickerRepository } from '../repositories/stickerRepository.js';
import { AppError } from '../utils/AppError.js';
import { detectFileType } from '../utils/fileType.js';
import { STICKER_TYPES } from './attachmentService.js';
import { TEMP_DIR, attachmentStorage } from './attachmentStorage.js';
import { messageService } from './messageService.js';
import { toAttachment } from './serializers.js';

export const MAX_SAVED_STICKERS = 200;
const notFound = () => AppError.notFound('Sticker not found');

export const toSticker = (row) => ({
  id: row.id,
  url: `/api/attachments/stickers/${row.id}`,
  mimeType: row.mime_type,
  width: row.width ?? null,
  height: row.height ?? null,
  createdAt: new Date(row.created_at).toISOString(),
});

async function assertRoom(userId) {
  if ((await stickerRepository.count(userId)) >= MAX_SAVED_STICKERS) {
    throw new AppError(409, 'TOO_MANY_STICKERS', `You can keep up to ${MAX_SAVED_STICKERS} stickers. Remove some first.`);
  }
}

/** Can `userId` see this attachment? (Sent: chat participants. Unsent: its uploader.) */
async function canSee(userId, row) {
  if (!row) return false;
  return row.message_id ? conversationRepository.isParticipant(row.conversation_id, userId) : row.uploader_id === userId;
}

export const stickerService = {
  async list(userId) {
    return (await stickerRepository.list(userId)).map(toSticker);
  },

  /** A new sticker from an image (the browser crops it to a square and converts it to WebP). */
  async create(userId, file, { width, height } = {}) {
    if (!file?.buffer?.length) throw AppError.badRequest('Choose an image');
    const type = detectFileType(file.buffer.subarray(0, 64), 'sticker');
    if (!STICKER_TYPES.has(type.mime)) throw new AppError(415, 'UNSUPPORTED_FILE', 'Stickers must be PNG, WebP or GIF images');
    if (file.buffer.length > config.uploads.maxBytes.sticker) throw new AppError(413, 'FILE_TOO_LARGE', 'Stickers can be at most 512 KB');
    await assertRoom(userId);
    const tempPath = path.join(TEMP_DIR, crypto.randomBytes(16).toString('hex'));
    await fs.writeFile(tempPath, file.buffer);
    try {
      const storageKey = await attachmentStorage.store(tempPath, type.mime);
      return toSticker(await stickerRepository.add({ userId, storageKey, mimeType: type.mime, sizeBytes: file.buffer.length, width, height }));
    } finally {
      await attachmentStorage.discardTemp(tempPath);
    }
  },

  /** "Save sticker" on a sticker someone sent: it joins my stickers (same file, no copy). */
  async saveFromAttachment(userId, attachmentId) {
    const row = await attachmentRepository.findById(attachmentId);
    if (!(await canSee(userId, row)) || row.kind !== 'sticker') throw notFound();
    await assertRoom(userId);
    return toSticker(
      await stickerRepository.add({
        userId,
        storageKey: row.storage_key,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        width: row.width,
        height: row.height,
      }),
    );
  },

  async remove(userId, id) {
    const row = await stickerRepository.find(userId, id);
    if (!row || !(await stickerRepository.remove(userId, id))) throw notFound();
    await attachmentStorage.releaseFiles([row.storage_key]); // only if no message or other list still uses it
  },

  /** Ready one of my stickers to send in a chat: an unsent attachment sharing its file. */
  async prepareToSend(userId, id, conversationId) {
    const row = await stickerRepository.find(userId, id);
    if (!row) throw notFound();
    await messageService.assertCanPost(userId, conversationId);
    const attachmentId = await attachmentRepository.insertShared({
      uploaderId: userId,
      conversationId,
      kind: 'sticker',
      mimeType: row.mime_type,
      originalName: `sticker.${row.mime_type.split('/')[1]}`,
      sizeBytes: row.size_bytes,
      storageKey: row.storage_key,
      width: row.width,
      height: row.height,
    });
    return toAttachment(await attachmentRepository.findById(attachmentId));
  },

  /** The image of one of my stickers (only its owner may load it). */
  async getImage(userId, id) {
    const row = await stickerRepository.find(userId, id);
    if (!row) throw notFound();
    return { storageKey: row.storage_key, mimeType: row.mime_type, name: 'sticker', inline: true };
  },
};
