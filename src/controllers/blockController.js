import { blockService } from '../services/blockService.js';
import { announceBlockChange } from '../sockets/handlers/presenceHandlers.js';
import { logger } from '../utils/logger.js';

function broadcast(blockerId, blockedId, blocked) {
  announceBlockChange(blockerId, blockedId, blocked).catch((error) =>
    logger.error('Block broadcast failed', { userId: blockerId, error }),
  );
}

export const blockController = {
  async list(req, res) {
    res.json({ blocked: await blockService.list(req.user.id) });
  },

  async block(req, res) {
    const { userId } = req.valid.body;
    const { created } = await blockService.block(req.user.id, userId);
    if (created) broadcast(req.user.id, userId, true);
    res.status(created ? 201 : 200).json({ userId, blocked: true });
  },

  async unblock(req, res) {
    const { userId } = req.valid.params;
    await blockService.unblock(req.user.id, userId);
    broadcast(req.user.id, userId, false);
    res.status(204).end();
  },
};
