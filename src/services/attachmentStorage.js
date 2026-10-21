import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { attachmentRepository } from '../repositories/attachmentRepository.js';
import { logger } from '../utils/logger.js';
import { objectStorage } from './objectStorage.js';

/**
 * Attachment files (chat photos, videos, voice notes, documents, stickers, GIFs and their
 * previews), stored under random 128-bit keys (never the user's file name) in object
 * storage, local disk or S3 (STORAGE_DRIVER), at attachments/ab/ab12…ef.
 * Uploads first land in TEMP_DIR on this server's disk, where their type is checked.
 */
export const TEMP_DIR = path.join(config.uploads.dir, 'tmp');
const KEY_PATTERN = /^[a-f0-9]{32}$/;

export const attachmentStorage = {
  newKey: () => crypto.randomBytes(16).toString('hex'),

  /** Where the file with this key is stored: "attachments/ab/ab12…ef". */
  objectKey(key) {
    if (!KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
    return `attachments/${key.slice(0, 2)}/${key}`;
  },

  /** Move an uploaded temp file into storage; returns its new key. */
  async store(tempPath, contentType = 'application/octet-stream') {
    const key = this.newKey();
    await objectStorage.current.put(this.objectKey(key), tempPath, contentType);
    return key;
  },

  async remove(key) {
    if (!key || !KEY_PATTERN.test(key)) return;
    await objectStorage.removeEverywhere(this.objectKey(key)).catch((error) => logger.warn('Could not delete attachment file', { error }));
  },

  /** First bytes of an uploaded temp file, for type detection. */
  async readHead(filePath, bytes = 4096) {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },

  /** Delete stored files that no attachment row uses any more (forwarded copies share files). */
  async releaseFiles(keys) {
    for (const key of new Set(keys)) {
      if (!(await attachmentRepository.isKeyInUse(key))) await this.remove(key);
    }
  },

  async discardTemp(filePath) {
    if (!filePath) return;
    await fs.unlink(filePath).catch(() => {});
  },
};
