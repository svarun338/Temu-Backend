import { contactRepository } from '../repositories/contactRepository.js';
import { blockRepository } from '../repositories/blockRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { AppError } from '../utils/AppError.js';
import { toContact } from './serializers.js';

export const contactService = {
  async list(userId) {
    const rows = await contactRepository.listForUser(userId);
    return rows.map(toContact);
  },

  /** Returns { contact, created }. */
  async add(userId, contactUserId) {
    if (userId === contactUserId) throw AppError.badRequest('You cannot add yourself as a contact');
    const target = await userRepository.findById(contactUserId);
    // Unverified accounts and people who blocked you are indistinguishable from missing users.
    if (!target || !target.email_verified_at) throw AppError.notFound('User not found');
    if ((await blockRepository.relation(userId, contactUserId)).blockedMe) throw AppError.notFound('User not found');

    const created = await contactRepository.add(userId, contactUserId);
    const contact = await contactRepository.findOne(userId, contactUserId);
    if (!contact) throw AppError.notFound('User not found'); // deleted concurrently
    return { contact: toContact(contact), created };
  },

  async remove(userId, contactUserId) {
    const removed = await contactRepository.remove(userId, contactUserId);
    if (!removed) throw AppError.notFound('Contact not found');
  },
};
