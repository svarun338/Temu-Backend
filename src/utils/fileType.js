import path from 'node:path';

/**
 * File type detection from content ("magic bytes"). The client's MIME type and
 * file name are never trusted for deciding how a file is stored or served.
 */

/** Extensions that run code when opened. Refused even if their content looks harmless. */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'msi', 'msix', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'vbs', 'vbe', 'js', 'jse', 'mjs',
  'wsf', 'wsh', 'ps1', 'psm1', 'jar', 'apk', 'appx', 'app', 'dmg', 'pkg', 'sh', 'bash', 'hta',
  'lnk', 'reg', 'msc', 'gadget', 'dll', 'sys', 'drv', 'ocx',
]);

/** Office formats are ZIP / OLE containers; the extension tells which one. */
const ZIP_DOCUMENTS = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
};
const OLE_DOCUMENTS = { doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint' };
const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'md', 'log', 'json', 'tsv']);

/** Types the browser may display inline (everything else is always downloaded). */
export const INLINE_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/aac',
  'application/pdf', 'text/plain',
]);

const ascii = (buf, start, end) => buf.toString('latin1', start, end);
const startsWith = (buf, bytes, offset = 0) => buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

export const extensionOf = (name) => path.extname(name || '').slice(1).toLowerCase();

function looksExecutable(buf) {
  return (
    startsWith(buf, [0x4d, 0x5a]) || // Windows PE ("MZ")
    startsWith(buf, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    startsWith(buf, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWith(buf, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWith(buf, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(buf, [0xca, 0xfe, 0xba, 0xbe]) || // Mach-O / Java class
    startsWith(buf, [0x23, 0x21]) // "#!" script
  );
}

function isLikelyText(buf) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.min(buf.length, 4000)));
    return true;
  } catch {
    // A multi-byte character may be cut at the end of the sample; allow that only.
    return false;
  }
}

/**
 * Identify a file. `head` is the first few KB. `wantsAudio` decides between audio
 * and video for containers that can hold either (WebM, MP4 from voice recorders).
 * Returns { mime, kind } where kind is image | video | audio | file, or { blocked: reason }.
 */
export function detectFileType(head, originalName, { wantsAudio = false } = {}) {
  const ext = extensionOf(originalName);
  if (BLOCKED_EXTENSIONS.has(ext)) return { blocked: 'This type of file cannot be sent for security reasons' };
  if (looksExecutable(head)) return { blocked: 'Programs and scripts cannot be sent for security reasons' };

  // Images
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', kind: 'image' };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', kind: 'image' };
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return { mime: 'image/gif', kind: 'image' };
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image' };

  // Audio / video containers
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WAVE') return { mime: 'audio/wav', kind: 'audio' };
  if (ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (brand === 'M4A ' || brand === 'M4B ' || wantsAudio) return { mime: 'audio/mp4', kind: 'audio' };
    if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'video' };
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return { mime: 'image/heic', kind: 'file' };
    return { mime: 'video/mp4', kind: 'video' };
  }
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    return wantsAudio ? { mime: 'audio/webm', kind: 'audio' } : { mime: 'video/webm', kind: 'video' };
  }
  if (ascii(head, 0, 4) === 'OggS') return { mime: 'audio/ogg', kind: 'audio' };
  if (ascii(head, 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe6) === 0xe2)) return { mime: 'audio/mpeg', kind: 'audio' };
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return { mime: 'audio/aac', kind: 'audio' };

  // Documents and archives
  if (ascii(head, 0, 5) === '%PDF-') return { mime: 'application/pdf', kind: 'file' };
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    return { mime: ZIP_DOCUMENTS[ext] ?? 'application/zip', kind: 'file' };
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { mime: OLE_DOCUMENTS[ext] ?? 'application/octet-stream', kind: 'file' };
  }
  if (ascii(head, 0, 4) === 'Rar!') return { mime: 'application/vnd.rar', kind: 'file' };
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { mime: 'application/x-7z-compressed', kind: 'file' };
  if (startsWith(head, [0x1f, 0x8b])) return { mime: 'application/gzip', kind: 'file' };

  if (TEXT_EXTENSIONS.has(ext) && isLikelyText(head)) return { mime: 'text/plain', kind: 'file' };

  // Anything else is allowed but always served as an opaque download.
  return { mime: 'application/octet-stream', kind: 'file' };
}

/** Make a user-supplied file name safe to store and to put in a download header. */
export function sanitizeFileName(name, fallback = 'file') {
  const cleaned = String(name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200);
  return cleaned || fallback;
}
