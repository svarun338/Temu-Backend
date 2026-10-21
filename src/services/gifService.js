import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { attachmentRepository } from '../repositories/attachmentRepository.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { TEMP_DIR, attachmentStorage } from './attachmentStorage.js';
import { messageService } from './messageService.js';
import { toAttachment } from './serializers.js';

const API = 'https://api.giphy.com/v1/gifs';
const PAGE_SIZE = 24;
// GIF files are only ever downloaded from GIPHY's own media servers.
const GIPHY_MEDIA = /^(media\d*\.giphy\.com|i\.giphy\.com)$/;
const TIMEOUT_MS = 10_000;

const disabled = () => new AppError(503, 'GIFS_DISABLED', 'GIF search is not set up on this server');

async function giphy(endpoint, params) {
  if (!config.gifs.enabled) throw disabled();
  const url = new URL(`${API}${endpoint}`);
  url.search = new URLSearchParams({ api_key: config.gifs.giphyKey, rating: config.gifs.rating, ...params }).toString();
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    logger.warn('GIPHY request failed', { endpoint, error });
    throw new AppError(502, 'GIFS_UNAVAILABLE', 'GIFs are not available right now. Please try again.');
  }
  if (response.status === 404) throw AppError.notFound('GIF not found');
  if (!response.ok) {
    logger.warn('GIPHY answered with an error', { endpoint, status: response.status });
    throw new AppError(502, 'GIFS_UNAVAILABLE', 'GIFs are not available right now. Please try again.');
  }
  return response.json();
}

const safeMediaUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && GIPHY_MEDIA.test(url.hostname) ? url.toString() : null;
  } catch {
    return null;
  }
};

/** What the picker needs: a small animated preview to show, and the id to send. */
function toResult(gif) {
  const preview = gif.images?.fixed_width_downsampled ?? gif.images?.fixed_width ?? gif.images?.preview_gif;
  const url = safeMediaUrl(preview?.webp || preview?.url);
  if (!url) return null;
  return { id: gif.id, title: (gif.title || 'GIF').slice(0, 100), previewUrl: url, width: Number(preview.width) || 200, height: Number(preview.height) || 150 };
}

function page(body, offset) {
  const results = (body.data ?? []).map(toResult).filter(Boolean);
  const total = Number(body.pagination?.total_count ?? 0);
  return { gifs: results, nextOffset: offset + PAGE_SIZE < Math.min(total, 4999) ? offset + PAGE_SIZE : null };
}

/** Download with a size cap; only GIF bytes are accepted. Returns a temp file path. */
async function downloadGif(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  if (!response.ok) throw new AppError(502, 'GIFS_UNAVAILABLE', 'This GIF could not be downloaded');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > config.gifs.maxBytes) throw new AppError(413, 'FILE_TOO_LARGE', 'This GIF is too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > config.gifs.maxBytes) throw new AppError(413, 'FILE_TOO_LARGE', 'This GIF is too large');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const magic = bytes.subarray(0, 6).toString('ascii');
  if (magic !== 'GIF89a' && magic !== 'GIF87a') throw new AppError(415, 'UNSUPPORTED_FILE', 'Not a GIF');
  const tempPath = path.join(TEMP_DIR, crypto.randomBytes(16).toString('hex'));
  await fs.writeFile(tempPath, bytes);
  return { tempPath, size: bytes.length };
}

export const gifService = {
  async trending(offset = 0) {
    return page(await giphy('/trending', { limit: String(PAGE_SIZE), offset: String(offset), bundle: 'messaging_non_clips' }), offset);
  },

  async search(query, offset = 0) {
    return page(await giphy('/search', { q: query, limit: String(PAGE_SIZE), offset: String(offset), lang: 'en', bundle: 'messaging_non_clips' }), offset);
  },

  /**
   * Turn a GIPHY GIF into an attachment of mine, ready to send. The details are
   * looked up again by id (never trusting a URL from the browser), and the file
   * is stored on our server, so the people I send it to never contact GIPHY.
   */
  async attach(userId, { conversationId, gifId }) {
    await messageService.assertCanPost(userId, conversationId);
    const { data: gif } = await giphy(`/${encodeURIComponent(gifId)}`, {});
    // Prefer a rendition under 2 MB that still looks good in a chat bubble.
    const rendition = [gif?.images?.downsized_medium, gif?.images?.downsized, gif?.images?.fixed_height].find(
      (r) => r?.url && Number(r.size || 0) <= config.gifs.maxBytes,
    );
    const url = safeMediaUrl(rendition?.url);
    if (!url) throw new AppError(422, 'UNSUPPORTED_FILE', 'This GIF cannot be sent');

    const { tempPath, size } = await downloadGif(url);
    try {
      const used = await attachmentRepository.uploadedBytesSince(userId, new Date(Date.now() - 24 * 3_600_000));
      if (used + size > config.uploads.dailyQuotaBytes) {
        throw new AppError(413, 'UPLOAD_QUOTA_EXCEEDED', 'You reached the daily upload limit. Please try again later.');
      }
      const storageKey = await attachmentStorage.store(tempPath, 'image/gif');
      const id = await attachmentRepository.insert({
        uploaderId: userId,
        conversationId,
        kind: 'image',
        mimeType: 'image/gif',
        originalName: 'GIF.gif',
        sizeBytes: size,
        storageKey,
        width: Number(rendition.width) || null,
        height: Number(rendition.height) || null,
      });
      return toAttachment(await attachmentRepository.findById(id));
    } finally {
      await attachmentStorage.discardTemp(tempPath);
    }
  },

  /** GIFs I sent before, to send again (works without a GIPHY key too). */
  async recent(userId) {
    return (await attachmentRepository.recentGifs(userId)).map(toAttachment);
  },

  /**
   * Send a GIF from my recent list (or one I received) again: a new unsent attachment
   * sharing the same file. I must be allowed to see the original.
   */
  async reuse(userId, { attachmentId, conversationId }) {
    const row = await attachmentRepository.findById(attachmentId);
    const visible = row?.message_id ? await conversationRepository.isParticipant(row.conversation_id, userId) : row?.uploader_id === userId;
    // Encrypted files are opaque here: the sender's device knows it's a GIF and passes on its key.
    const reusable = row && (row.mime_type === 'image/gif' || (Number(row.encrypted) && row.kind === 'image'));
    if (!reusable || !visible) throw AppError.notFound('GIF not found');
    await messageService.assertCanPost(userId, conversationId);
    const id = await attachmentRepository.insertShared({
      uploaderId: userId,
      conversationId,
      kind: 'image',
      mimeType: row.mime_type,
      originalName: row.original_name,
      sizeBytes: row.size_bytes,
      storageKey: row.storage_key,
      width: row.width,
      height: row.height,
      encrypted: Boolean(Number(row.encrypted)),
    });
    return toAttachment(await attachmentRepository.findById(id));
  },
};
