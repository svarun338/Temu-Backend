import { recordingService } from '../services/recordingService.js';
import { AppError } from '../utils/AppError.js';
import { sendStoredFile } from '../utils/storedFile.js';

export { parseRange } from '../utils/storedFile.js';

/** RFC 6266 Content-Disposition with an ASCII fallback (recording names are ASCII already). */
const disposition = (type, name) => `${type}; filename="${name}"`;

export const recordingController = {
  async start(req, res) {
    const recording = await recordingService.start(req.user.id, req.valid.params.id, req.valid.body);
    res.status(201).json({ recording });
  },

  async listForCall(req, res) {
    res.json({ recordings: await recordingService.listForCall(req.user.id, req.valid.params.id) });
  },

  async appendChunk(req, res) {
    const { recordingId, seq } = req.valid.params;
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the chunk as application/octet-stream');
    res.json(await recordingService.appendChunk(req.user.id, recordingId, seq, bytes));
  },

  async finish(req, res) {
    const recording = await recordingService.finish(req.user.id, req.valid.params.recordingId, req.valid.body);
    res.json({ recording });
  },

  async remove(req, res) {
    await recordingService.remove(req.user.id, req.valid.params.recordingId);
    res.status(204).end();
  },

  /** Stream a recording (whole or a byte range, so players can seek) from local disk or S3. */
  async download(req, res) {
    const file = await recordingService.getForDownload(req.user.id, req.valid.params.recordingId);
    await sendStoredFile(req, res, {
      key: file.key,
      storage: file.storage, // the driver it was saved with
      size: file.size,
      headers: {
        'Content-Type': file.mimeType,
        'Content-Disposition': disposition(req.valid.query.download === '1' ? 'attachment' : 'inline', file.name),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
        'Content-Security-Policy': "default-src 'none'; media-src 'self'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-site',
      },
    });
  },
};
