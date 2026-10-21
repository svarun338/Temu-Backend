import { blockRepository } from '../repositories/blockRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { AppError } from '../utils/AppError.js';
import { toBlockedUser } from './serializers.js';

export const blockService = {
  async list(userId) {
    const rows = await blockRepository.listBlockedBy(userId);
    return rows.map(toBlockedUser);
  },

  /** Returns { created }. */
  async block(userId, targetId) {
    if (userId === targetId) throw AppError.badRequest('You cannot block yourself');
    if (!(await userRepository.findById(targetId))) throw AppError.notFound('User not found');
    return { created: await blockRepository.block(userId, targetId) };
  },

  async unblock(userId, targetId) {
    if (!(await blockRepository.unblock(userId, targetId))) throw AppError.notFound('This user is not blocked');
  },

  /** Throws 403 if either user blocked the other. */
  async assertCanInteract(userId, otherId) {
    const { blockedByMe, blockedMe } = await blockRepository.relation(userId, otherId);
    if (blockedByMe) throw new AppError(403, 'BLOCKED', 'You blocked this user. Unblock them to send messages.');
    // Deliberately vague: don't confirm that the other person blocked you.
    if (blockedMe) throw new AppError(403, 'CANNOT_MESSAGE', "You can't send messages to this user.");
  },

  isBlockedBetween(userA, userB) {
    return blockRepository.existsBetween(userA, userB);
  },

  listRelatedIds(userId) {
    return blockRepository.listRelatedIds(userId);
  },
};
