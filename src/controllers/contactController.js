import { contactService } from '../services/contactService.js';
import { notificationService } from '../services/notificationService.js';

export const contactController = {
  async list(req, res) {
    res.json({ contacts: await contactService.list(req.user.id) });
  },

  async add(req, res) {
    const { contact, created } = await contactService.add(req.user.id, req.valid.body.userId);
    if (created) {
      notificationService.run(() => notificationService.contactAdded(req.user.id, contact.id), { userId: req.user.id });
    }
    res.status(created ? 201 : 200).json({ contact });
  },

  async remove(req, res) {
    await contactService.remove(req.user.id, req.valid.params.userId);
    res.status(204).end();
  },
};
