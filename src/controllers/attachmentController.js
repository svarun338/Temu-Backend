import { attachmentService } from '../services/attachmentService.js';
import { attachmentStorage } from '../services/attachmentStorage.js';
import { AppError } from '../utils/AppError.js';
import { sendStoredFile } from '../utils/storedFile.js';
import { formatIssues, schemas } from '../validation/schemas.js';

/** RFC 6266 Content-Disposition with an ASCII fallback and the UTF-8 name. */
function contentDisposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Send a stored attachment (local disk or S3), with byte ranges so videos and voice notes can seek. */
export async function sendAttachment(req, res, _next, file) {
  const asDownload = req.valid.query.download === '1' || !file.inline;
  const headers = {
    'Content-Type': asDownload && !file.inline ? 'application/octet-stream' : file.mimeType,
    'Content-Disposition': contentDisposition(asDownload ? 'attachment' : 'inline', file.name),
    'X-Content-Type-Options': 'nosniff',
    // Private: only the browser may cache it, never a shared proxy.
    'Cache-Control': 'private, max-age=3600',
    'Cross-Origin-Resource-Policy': 'same-site',
  };
  if (file.mimeType === 'application/pdf') {
    // Browsers' PDF viewers break under a sandboxing CSP; PDFs never run scripts in our origin.
    res.removeHeader('Content-Security-Policy');
  } else {
    headers['Content-Security-Policy'] = "default-src 'none'; media-src 'self'; img-src 'self'; sandbox";
  }
  await sendStoredFile(req, res, { key: attachmentStorage.objectKey(file.storageKey), headers });
}

export const attachmentController = {
  /** Multipart upload. Fields are validated here so temp files can be removed on any failure. */
  async upload(req, res) {
    const file = req.files?.file?.[0];
    const thumbnail = req.files?.thumbnail?.[0];
    const parsed = schemas.uploadAttachment.safeParse(req.body ?? {});
    if (!parsed.success) {
      await attachmentStorage.discardTemp(file?.path);
      await attachmentStorage.discardTemp(thumbnail?.path);
      throw AppError.validation(formatIssues(parsed.error));
    }
    const { kind, ...rest } = parsed.data; // includes `encrypted`
    const attachment = await attachmentService.upload(req.user.id, { ...rest, kindHint: kind, file, thumbnail });
    res.status(201).json({ attachment });
  },

  async download(req, res, next) {
    const file = await attachmentService.getForDownload(req.user.id, req.valid.params.attachmentId);
    await sendAttachment(req, res, next, file);
  },

  async thumbnail(req, res, next) {
    const file = await attachmentService.getForDownload(req.user.id, req.valid.params.attachmentId, { thumbnail: true });
    await sendAttachment(req, res, next, file);
  },

  async gallery(req, res) {
    res.json(await attachmentService.gallery(req.user.id, req.valid.params.id, req.valid.query));
  },
};
