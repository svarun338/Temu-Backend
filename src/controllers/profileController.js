import { profileService } from '../services/profileService.js';
import { announceProfileChange } from '../sockets/handlers/presenceHandlers.js';
import { logger } from '../utils/logger.js';

/** Push the change to contacts without failing the request if broadcasting fails. */
function broadcast(user) {
  announceProfileChange(user).catch((error) => logger.error('Profile broadcast failed', { userId: user.id, error }));
}

export const profileController = {
  async get(req, res) {
    res.json({ user: await profileService.getOwn(req.user.id) });
  },

  async update(req, res) {
    const user = await profileService.update(req.user.id, req.valid.body);
    broadcast(user);
    res.json({ user });
  },

  async setAvatar(req, res) {
    const user = await profileService.setAvatar(req.user.id, req.file);
    broadcast(user);
    res.json({ user });
  },

  async removeAvatar(req, res) {
    const user = await profileService.removeAvatar(req.user.id);
    broadcast(user);
    res.json({ user });
  },
};
