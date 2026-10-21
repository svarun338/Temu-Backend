import { callService } from '../services/callService.js';
import { groupCallService } from '../services/groupCallService.js';

export const callController = {
  async history(req, res) {
    res.json(await callService.history(req.user.id, req.valid.query));
  },

  async hide(req, res) {
    await callService.hide(req.user.id, req.valid.body);
    res.status(204).end();
  },

  iceServers(req, res) {
    res.json({ iceServers: callService.iceServers(req.user.id) });
  },

  /** Group calls going on in my groups (for the "Join call" banner). */
  async active(req, res) {
    res.json({ calls: await groupCallService.activeFor(req.user.id) });
  },
};
