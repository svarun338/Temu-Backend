import { settingsService } from '../services/settingsService.js';
import { wallpaperService } from '../services/wallpaperService.js';
import { realtime } from '../sockets/realtime.js';

/** Wallpapers and per-chat appearance. Changes are mirrored to my other tabs. */
export const appearanceController = {
  async listWallpapers(req, res) {
    res.json({ wallpapers: await wallpaperService.list(req.user.id) });
  },

  async uploadWallpaper(req, res) {
    res.status(201).json({ wallpaper: await wallpaperService.upload(req.user.id, req.file) });
  },

  async deleteWallpaper(req, res) {
    await wallpaperService.remove(req.user.id, req.valid.params.wallpaperId);
    // Settings or chats that used it now fall back to the default.
    realtime.emitToUsers([req.user.id], 'settings:updated', await settingsService.get(req.user.id));
    res.status(204).end();
  },

  async setChatWallpaper(req, res) {
    const result = await settingsService.setConversationWallpaper(req.user.id, req.valid.params.id, req.valid.body.wallpaper);
    realtime.emitToUsers([req.user.id], 'conversation:wallpaper', result);
    res.json(result);
  },
};
