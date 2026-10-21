import crypto from 'node:crypto';
import fs from 'node:fs';
import multer from 'multer';
import { config } from '../config/index.js';
import { TEMP_DIR } from '../services/attachmentStorage.js';

/**
 * Single in-memory image upload in field "avatar". Size and count are capped
 * here; the actual file type is verified from its bytes in profileService.
 */
export const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.avatarMaxBytes, files: 1, fields: 0, parts: 2 },
}).single('avatar');

/** One wallpaper image in field "image" (resized in the browser; type checked from bytes). */
export const wallpaperUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 2 },
}).single('image');

/** One sticker image in field "image" (cropped and converted in the browser; type checked from bytes). */
export const stickerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.uploads.maxBytes.sticker, files: 1, fields: 2, fieldSize: 16, parts: 3 },
}).single('image');

fs.mkdirSync(TEMP_DIR, { recursive: true });

/**
 * Chat attachment upload: field "file" (plus an optional "thumbnail" for videos)
 * streamed to a temp file with a random name. The hard cap is the largest
 * per-kind limit; the exact limit for the detected kind is checked afterwards.
 */
export const attachmentUpload = multer({
  storage: multer.diskStorage({
    destination: TEMP_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: {
    fileSize: Math.max(...Object.values(config.uploads.maxBytes)),
    files: 2,
    fields: 8,
    fieldSize: 1024,
  },
}).fields([
  { name: 'file', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 },
]);
