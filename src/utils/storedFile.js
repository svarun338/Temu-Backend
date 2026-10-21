import { objectStorage } from '../services/objectStorage.js';
import { AppError } from './AppError.js';

/**
 * One byte range from a Range header ("bytes=0-", "bytes=100-199", "bytes=-500"), end inclusive.
 * null: no (usable) Range header, send everything. false: the range cannot be satisfied.
 */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null; // multiple or malformed ranges: whole file
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return false;
  return { start, end };
}

/**
 * Stream a stored file (local disk or S3) to the response, whole or as one byte range so
 * players can seek. `headers` are set on every response (type, disposition, caching…).
 * `storage` + `size` may be given (recordings know their driver); otherwise the file is located.
 */
export async function sendStoredFile(req, res, { key, headers, storage, size }) {
  if (!storage) {
    try {
      ({ storage, size } = await objectStorage.locate(key));
    } catch (error) {
      if (error.code === 'ENOENT') throw AppError.notFound('File not found');
      throw error;
    }
  }
  const range = parseRange(req.headers.range, size);
  if (range === false) {
    res.setHeader('Content-Range', `bytes */${size}`);
    throw new AppError(416, 'RANGE_NOT_SATISFIABLE', 'Requested range not satisfiable');
  }
  let stream;
  try {
    stream = await storage.read(key, range ?? undefined);
  } catch (error) {
    if (error.code === 'ENOENT') throw AppError.notFound('File not found');
    throw error;
  }
  res.status(range ? 206 : 200);
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.setHeader('Content-Length', range ? range.end - range.start + 1 : size);
  res.setHeader('Accept-Ranges', 'bytes');
  if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  if (req.method === 'HEAD') {
    stream.destroy?.();
    res.end();
    return;
  }
  stream.on('error', (error) => res.destroy(error));
  stream.pipe(res);
}
