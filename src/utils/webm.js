import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * Browsers' MediaRecorder writes WebM as a live stream: the file never says how long it
 * is, so players show no total time and can't seek. Once a recording is complete we
 * know its length; this writes it into the file's Segment › Info › Duration element.
 *
 * Only the first few hundred bytes change (Info grows by 11 bytes). Files whose layout
 * this can't patch safely (a SeekHead with byte offsets, Info not near the start, a
 * Duration already present) are left as they are.
 */
const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Cluster: 0x1f43b675,
};
const HEAD_BYTES = 64 * 1024;

/** An element ID (the length marker stays part of the ID). */
function readId(buf, pos) {
  const first = buf[pos];
  const length = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
  if (!length || pos + length > buf.length) return null;
  return { id: buf.readUIntBE(pos, length), length };
}

/** A size VINT: { value (null when "unknown"), length }. */
function readSize(buf, pos) {
  const first = buf[pos];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  if (length > 8 || pos + length > buf.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value: allOnes ? null : value, length };
}

/** `value` as a size VINT of exactly `length` bytes (null if it doesn't fit). */
function encodeSize(value, length) {
  if (value >= 2 ** (7 * length) - 1) return null;
  const out = Buffer.alloc(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function element(buf, pos) {
  const id = readId(buf, pos);
  if (!id) return null;
  const size = readSize(buf, pos + id.length);
  if (!size) return null;
  const dataStart = pos + id.length + size.length;
  return { id: id.id, sizePos: pos + id.length, sizeLength: size.length, size: size.value, dataStart, end: size.value === null ? null : dataStart + size.value };
}

/** The patched start of the file, and where the unchanged rest begins; null if not patchable. */
export function patchHead(head, durationMs) {
  const ebml = element(head, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.end === null) return null;
  const segment = element(head, ebml.end);
  if (!segment || segment.id !== ID.Segment) return null;

  let pos = segment.dataStart;
  let info = null;
  while (pos < head.length) {
    const child = element(head, pos);
    if (!child || child.end === null) return null;
    if (child.id === ID.SeekHead || child.id === ID.Cluster) return null; // offsets would shift / no Info first
    if (child.id === ID.Info) {
      info = child;
      break;
    }
    pos = child.end;
  }
  if (!info || info.end > head.length) return null;

  let timecodeScale = 1_000_000;
  for (let p = info.dataStart; p < info.end; ) {
    const child = element(head, p);
    if (!child || child.end === null || child.end > info.end) return null;
    if (child.id === ID.Duration) return null; // already known
    if (child.id === ID.TimecodeScale) timecodeScale = head.readUIntBE(child.dataStart, child.size);
    p = child.end;
  }

  // Duration: float64, in TimecodeScale units (nanoseconds per unit).
  const duration = Buffer.alloc(11);
  duration.writeUInt16BE(ID.Duration, 0);
  duration[2] = 0x88; // size 8
  duration.writeDoubleBE((durationMs * 1_000_000) / timecodeScale, 3);

  const infoSize = encodeSize(info.size + duration.length, 8);
  const grow = 8 - info.sizeLength + duration.length;
  let segmentSize = head.subarray(segment.sizePos, segment.dataStart);
  if (segment.size !== null) {
    segmentSize = encodeSize(segment.size + grow, segment.sizeLength);
    if (!segmentSize) return null;
  }
  const patched = Buffer.concat([
    head.subarray(0, segment.sizePos),
    segmentSize,
    head.subarray(segment.dataStart, info.sizePos),
    infoSize,
    head.subarray(info.dataStart, info.end),
    duration,
  ]);
  return { patched, restFrom: info.end };
}

/** Reads a file front to back through a 1 MB window (element headers are read one by one). */
class Reader {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
    this.buffer = Buffer.alloc(1024 * 1024);
    this.start = 0;
    this.length = 0;
  }

  /** At least `n` bytes from `pos` (fewer at the end of the file), as a Buffer view. */
  async bytes(pos, n) {
    if (pos < this.start || pos + n > this.start + this.length) {
      const { bytesRead } = await this.handle.read(this.buffer, 0, this.buffer.length, pos);
      this.start = pos;
      this.length = bytesRead;
    }
    return this.buffer.subarray(pos - this.start, Math.min(pos - this.start + n, this.length));
  }
}

const SimpleBlock = 0xa3;
const BlockGroup = 0xa0;
const Block = 0xa1;
const Timecode = 0xe7;

/**
 * How long the media in a WebM file really is, in ms: the time of its last audio/video
 * frame. Recordings can end earlier than the clock says (the recorder's connection
 * dropped and later pieces never arrived), so the file itself is the truth.
 * Returns null when the file isn't laid out as expected.
 */
export async function webmDurationMs(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const reader = new Reader(handle, size);
    const head = await reader.bytes(0, 64);
    const ebml = element(head, 0);
    if (!ebml || ebml.id !== ID.EBML || ebml.end === null) return null;
    const segmentHead = await reader.bytes(ebml.end, 16);
    const segment = element(segmentHead, 0);
    if (!segment || segment.id !== ID.Segment) return null;

    let timecodeScale = 1_000_000;
    let clusterTime = 0;
    let last = null;
    let pos = ebml.end + segment.dataStart;
    while (pos < size) {
      const view = await reader.bytes(pos, 16);
      const el = element(view, 0);
      if (!el) break; // a cut-off last element
      const dataStart = pos + el.dataStart;
      if (el.id === ID.Cluster || el.id === BlockGroup) {
        pos = dataStart; // containers: look inside
        continue;
      }
      if (el.size === null) return null; // only clusters may have an unknown size
      if (el.id === ID.Info) {
        // TimecodeScale lives in Info
        const info = await reader.bytes(dataStart, Math.min(el.size, 4096));
        for (let p = 0; p < info.length; ) {
          const child = element(info, p);
          if (!child || child.end === null) break;
          if (child.id === ID.TimecodeScale) timecodeScale = info.readUIntBE(child.dataStart, child.size);
          p = child.end;
        }
      } else if (el.id === Timecode) {
        clusterTime = (await reader.bytes(dataStart, el.size)).readUIntBE(0, el.size);
      } else if (el.id === SimpleBlock || el.id === Block) {
        const block = await reader.bytes(dataStart, 12);
        const track = readSize(block, 0);
        if (track && block.length >= track.length + 2) {
          const time = clusterTime + block.readInt16BE(track.length);
          last = last === null ? time : Math.max(last, time);
        }
      }
      pos = dataStart + el.size;
    }
    return last === null ? null : Math.round((last * timecodeScale) / 1_000_000);
  } finally {
    await handle.close();
  }
}

/** Write `durationMs` into the WebM file at `filePath` (in place). Returns true if it was patched. */
export async function addWebmDuration(filePath, durationMs) {
  const handle = await fs.open(filePath, 'r');
  let head;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const result = patchHead(head, durationMs);
  if (!result) return false;

  const patchedPath = `${filePath}.duration`;
  const out = createWriteStream(patchedPath);
  out.write(result.patched);
  await pipeline(createReadStream(filePath, { start: result.restFrom }), out);
  await fs.rename(patchedPath, filePath);
  return true;
}
