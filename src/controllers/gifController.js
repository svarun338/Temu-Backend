import { gifService } from '../services/gifService.js';

export const gifController = {
  async trending(req, res) {
    res.json(await gifService.trending(req.valid.query.offset));
  },

  async search(req, res) {
    res.json(await gifService.search(req.valid.query.q, req.valid.query.offset));
  },

  async recent(req, res) {
    res.json({ gifs: await gifService.recent(req.user.id) });
  },

  async attach(req, res) {
    res.status(201).json({ attachment: await gifService.attach(req.user.id, req.valid.body) });
  },

  async reuse(req, res) {
    res.status(201).json({ attachment: await gifService.reuse(req.user.id, req.valid.body) });
  },
};
