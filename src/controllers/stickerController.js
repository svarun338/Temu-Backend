import { stickerService } from '../services/stickerService.js';
import { AppError } from '../utils/AppError.js';
import { formatIssues, schemas } from '../validation/schemas.js';
import { sendAttachment } from './attachmentController.js';

export const stickerController = {
  async list(req, res) {
    res.json({ stickers: await stickerService.list(req.user.id) });
  },

  /** Multipart: field "image" plus optional width/height. */
  async create(req, res) {
    const parsed = schemas.newSticker.safeParse(req.body ?? {});
    if (!parsed.success) throw AppError.validation(formatIssues(parsed.error));
    res.status(201).json({ sticker: await stickerService.create(req.user.id, req.file, parsed.data) });
  },

  async save(req, res) {
    res.status(201).json({ sticker: await stickerService.saveFromAttachment(req.user.id, req.valid.body.attachmentId) });
  },

  async remove(req, res) {
    await stickerService.remove(req.user.id, req.valid.params.id);
    res.status(204).end();
  },

  async prepare(req, res) {
    res.status(201).json({ attachment: await stickerService.prepareToSend(req.user.id, req.valid.params.id, req.valid.body.conversationId) });
  },

  async image(req, res, next) {
    await sendAttachment(req, res, next, await stickerService.getImage(req.user.id, req.valid.params.id));
  },
};
