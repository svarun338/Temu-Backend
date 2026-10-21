import { config } from '../config/index.js';
import { settingsRepository } from '../repositories/settingsRepository.js';
import { conversationService } from './conversationService.js';
import { wallpaperService } from './wallpaperService.js';

/** "Muted forever" is stored as a far-future date so one column covers every case. */
const FOREVER = new Date('9999-12-31T00:00:00Z');
const MUTE_DURATIONS = { '8h': 8 * 3_600_000, '1w': 7 * 24 * 3_600_000 };

export function toSettings(row) {
  return {
    notificationsEnabled: Boolean(row.notifications_enabled),
    messagePreview: Boolean(row.message_preview),
    soundEnabled: Boolean(row.sound_enabled),
    privacy: { lastSeen: row.last_seen_visibility ?? 'everyone' },
    appearance: {
      theme: row.theme ?? 'system',
      accent: row.accent ?? 'indigo',
      fontSize: row.font_size ?? 'medium',
      bubbleStyle: row.bubble_style ?? 'rounded',
      defaultWallpaper: row.default_wallpaper ?? null,
    },
    push: { available: config.push.enabled, publicKey: config.push.enabled ? config.push.publicKey : null },
    gifs: { search: config.gifs.enabled },
  };
}

export const settingsService = {
  async get(userId) {
    return toSettings(await settingsRepository.getUserSettings(userId));
  },

  async update(userId, { notificationsEnabled, messagePreview, soundEnabled, privacy = {}, appearance = {} }) {
    if (appearance.defaultWallpaper !== undefined) await wallpaperService.assertUsable(userId, appearance.defaultWallpaper);
    await settingsRepository.updateUserSettings(userId, {
      notifications_enabled: notificationsEnabled,
      message_preview: messagePreview,
      sound_enabled: soundEnabled,
      last_seen_visibility: privacy.lastSeen,
      theme: appearance.theme,
      accent: appearance.accent,
      font_size: appearance.fontSize,
      bubble_style: appearance.bubbleStyle,
      default_wallpaper: appearance.defaultWallpaper,
    });
    return this.get(userId);
  },

  /** duration: '8h' | '1w' | 'always' | null (unmute). Returns the new mutedUntil (ISO) or null. */
  async muteConversation(userId, conversationId, duration) {
    await conversationService.assertParticipant(conversationId, userId);
    const mutedUntil = duration === null ? null : duration === 'always' ? FOREVER : new Date(Date.now() + MUTE_DURATIONS[duration]);
    await settingsRepository.setMutedUntil(userId, conversationId, mutedUntil);
    return { conversationId, mutedUntil: mutedUntil ? mutedUntil.toISOString() : null };
  },

  /** My wallpaper for one chat (null = use my default). Only I see it. */
  async setConversationWallpaper(userId, conversationId, wallpaper) {
    await conversationService.assertParticipant(conversationId, userId);
    await wallpaperService.assertUsable(userId, wallpaper);
    await settingsRepository.setChatWallpaper(userId, conversationId, wallpaper);
    return { conversationId, wallpaper };
  },
};
