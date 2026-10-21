import { notificationService } from '../services/notificationService.js';
import { pushService } from '../services/pushService.js';
import { settingsService } from '../services/settingsService.js';
import { realtime } from '../sockets/realtime.js';
import { announceVisibilityChange } from '../sockets/handlers/presenceHandlers.js';
import { logger } from '../utils/logger.js';

export const settingsController = {
  async get(req, res) {
    res.json({ settings: await settingsService.get(req.user.id) });
  },

  async update(req, res) {
    const settings = await settingsService.update(req.user.id, req.valid.body);
    realtime.emitToUsers([req.user.id], 'settings:updated', settings);
    if (req.valid.body.privacy?.lastSeen) {
      announceVisibilityChange(req.user.id).catch((error) => logger.error('Presence visibility update failed', { userId: req.user.id, error }));
    }
    res.json({ settings });
  },

  async subscribePush(req, res) {
    await pushService.subscribe(req.user.id, req.sessionId, req.valid.body, req.get('user-agent'));
    res.status(201).json({ subscribed: true });
  },

  async unsubscribePush(req, res) {
    await pushService.unsubscribe(req.user.id, req.valid.body.endpoint);
    res.status(204).end();
  },

  async listNotifications(req, res) {
    res.json(await notificationService.list(req.user.id, req.valid.query));
  },

  async markNotificationsRead(req, res) {
    const result = await notificationService.markRead(req.user.id, req.valid.body.ids);
    realtime.emitToUsers([req.user.id], 'notifications:read', result);
    res.json(result);
  },
};
