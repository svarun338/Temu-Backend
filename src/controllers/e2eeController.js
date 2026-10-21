import { conversationRepository } from '../repositories/conversationRepository.js';
import { conversationService } from '../services/conversationService.js';
import { e2eeService } from '../services/e2eeService.js';
import { messageService } from '../services/messageService.js';
import { realtime } from '../sockets/realtime.js';
import { AppError } from '../utils/AppError.js';

export const e2eeController = {
  async listDevices(req, res) {
    res.json({ devices: await e2eeService.listDevices(req.user.id, req.deviceId) });
  },

  /** Register this browser's public key; contacts are told when a new device appears. */
  async registerDevice(req, res) {
    const { device, events } = await e2eeService.registerDevice(req.user.id, req.valid.body);
    for (const event of events) {
      const message = await messageService.broadcastCopy(event.messageId);
      if (message) realtime.broadcastMessage({ message, participantIds: event.participantIds });
    }
    res.status(201).json({ device });
  },

  async revokeDevice(req, res) {
    await e2eeService.revokeDevice(req.user.id, req.valid.params.id);
    res.status(204).end();
  },

  /** Devices a new message in this chat must be encrypted for (participants only). */
  async conversationDevices(req, res) {
    await conversationService.assertParticipant(req.valid.params.id, req.user.id);
    res.json({ devices: await e2eeService.devicesForConversation(req.valid.params.id) });
  },

  /**
   * Someone's devices, for comparing security codes. Only for people I share a chat
   * with (so device keys can't be collected for arbitrary users).
   */
  async userDevices(req, res) {
    const otherId = req.valid.params.id;
    if (otherId !== req.user.id && !(await conversationRepository.shareConversation(req.user.id, otherId))) {
      throw AppError.notFound('User not found');
    }
    res.json({ devices: await e2eeService.devicesOfUsers([otherId]) });
  },
};
