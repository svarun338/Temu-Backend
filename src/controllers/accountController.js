import { accountService } from '../services/accountService.js';
import { realtime } from '../sockets/realtime.js';
import { logger } from '../utils/logger.js';
import { clearSessionCookies } from './authController.js';
import { publishGroupChange } from './groupController.js';

export const accountController = {
  /** "Download my data" as a JSON file. */
  async exportData(req, res) {
    const data = await accountService.exportData(req.user.id);
    res.setHeader('Content-Disposition', `attachment; filename="temu-my-data-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  },

  /** Permanently delete my account (password required), then tell everyone affected. */
  async deleteAccount(req, res) {
    const userId = req.user.id;
    const result = await accountService.deleteAccount(userId, req.valid.body.password);
    clearSessionCookies(res);
    res.status(204).end();

    // After responding: sign out my other devices and update everyone who had me on screen.
    realtime.disconnectSessions(result.sessionIds);
    for (const { conversationId, userId: partnerId } of result.partnerChats) {
      realtime.emitToUsers([partnerId], 'conversation:removed', { conversationId });
    }
    realtime.emitToUsers(result.affectedUserIds, 'user:deleted', { userId });
    for (const change of result.groupChanges) {
      await publishGroupChange(change, userId).catch((error) => logger.error('Group update after account deletion failed', { userId, error }));
    }
  },
};
