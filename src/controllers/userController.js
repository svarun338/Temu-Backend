import { profileService } from '../services/profileService.js';
import { userService } from '../services/userService.js';

export const userController = {
  async search(req, res) {
    const users = await userService.search(req.user.id, req.valid.query.q);
    res.json({ users });
  },

  async get(req, res) {
    res.json({ user: await profileService.getPublic(req.user.id, req.valid.params.userId) });
  },
};
