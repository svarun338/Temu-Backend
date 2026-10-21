import { userRepository } from '../repositories/userRepository.js';
import { toSearchResult } from './serializers.js';

export const userService = {
  async search(currentUserId, query) {
    const rows = await userRepository.search({ query, excludeUserId: currentUserId, limit: 20 });
    return rows.map(toSearchResult);
  },
};
