import crypto from 'node:crypto';
import { settingsRepository } from '../repositories/settingsRepository.js';
import { wallpaperRepository } from '../repositories/wallpaperRepository.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { objectStorage } from './objectStorage.js';
import { IMAGE_MIME, detectImageType } from './profileService.js';

/** Custom wallpapers are stored at wallpapers/<name> (local disk or S3) and served at /uploads/wallpapers/<name>. */
export const WALLPAPER_PRESETS = ['none', 'dots', 'grid', 'waves', 'sunset', 'ocean', 'forest', 'lavender', 'night'];
const MAX_CUSTOM = 10;
const FILE_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

const toWallpaper = (row) => ({ id: row.id, value: `custom:${row.id}`, url: `/uploads/wallpapers/${row.file_name}` });

export const wallpaperService = {
  async list(userId) {
    return (await wallpaperRepository.listForUser(userId)).map(toWallpaper);
  },

  /** Store a validated image (JPG/PNG/WebP, detected from its bytes) under a random name. */
  async upload(userId, file) {
    if (!file?.buffer?.length) throw AppError.badRequest('Choose an image');
    const type = detectImageType(file.buffer);
    if (!type) throw new AppError(415, 'UNSUPPORTED_FILE', 'Only JPG, PNG or WebP images can be used as wallpapers');
    if ((await wallpaperRepository.countForUser(userId)) >= MAX_CUSTOM) {
      throw new AppError(409, 'TOO_MANY_WALLPAPERS', `You can keep up to ${MAX_CUSTOM} wallpapers. Delete one first.`);
    }
    const fileName = `${crypto.randomBytes(16).toString('hex')}.${type}`;
    await objectStorage.current.putBuffer(`wallpapers/${fileName}`, file.buffer, IMAGE_MIME[type]);
    const id = await wallpaperRepository.create(userId, fileName);
    return toWallpaper({ id, file_name: fileName });
  },

  /** Delete my wallpaper; chats using it fall back to the default. */
  async remove(userId, id) {
    const row = await wallpaperRepository.findOwned(userId, id);
    if (!row) throw AppError.notFound('Wallpaper not found');
    await wallpaperRepository.delete(id);
    await settingsRepository.clearWallpaperEverywhere(userId, `custom:${id}`);
    await this.deleteFile(row.file_name);
  },

  /** Remove a wallpaper's file (only names we generated: no path tricks). */
  async deleteFile(fileName) {
    if (!FILE_NAME.test(fileName ?? '')) return;
    await objectStorage.removeEverywhere(`wallpapers/${fileName}`).catch((error) => logger.warn('Could not delete wallpaper file', { error }));
  },

  /** A wallpaper value is a known preset or one of the user's own uploads. */
  async assertUsable(userId, value) {
    if (value == null) return;
    const [kind, name] = value.split(':');
    if (kind === 'preset' && WALLPAPER_PRESETS.includes(name)) return;
    if (kind === 'custom' && /^\d+$/.test(name) && (await wallpaperRepository.findOwned(userId, Number(name)))) return;
    throw AppError.badRequest('Choose one of the available wallpapers');
  },

  /** URL for a custom wallpaper value (null for presets). */
  async urlFor(userId, value) {
    if (!value?.startsWith('custom:')) return null;
    const row = await wallpaperRepository.findOwned(userId, Number(value.slice(7)));
    return row ? `/uploads/wallpapers/${row.file_name}` : null;
  },
};
