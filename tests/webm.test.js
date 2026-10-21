import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addWebmDuration, patchHead, webmDurationMs } from '../src/utils/webm.js';

// A tiny WebM laid out like Chrome's MediaRecorder output.
const el = (idHex, payload, sizeBytes) => {
  const id = Buffer.from(idHex, 'hex');
  const size = sizeBytes ?? Buffer.from([0x80 | payload.length]);
  return Buffer.concat([id, size, payload]);
};
const UNKNOWN = Buffer.from('01ffffffffffffff', 'hex');
const ebmlHeader = el('1a45dfa3', Buffer.concat([el('4282', Buffer.from('webm'))]));
const info = (extra = []) => el('1549a966', Buffer.concat([el('2ad7b1', Buffer.from([0x0f, 0x42, 0x40])), el('4d80', Buffer.from('Chrome')), ...extra]));
const tracks = el('1654ae6b', Buffer.from([0xae, 0x80]));
const cluster = el('1f43b675', Buffer.concat([el('e7', Buffer.from([0x00])), el('a3', Buffer.alloc(40, 9))]));

function webm({ segmentSize = UNKNOWN, children = [info(), tracks, cluster] } = {}) {
  const body = Buffer.concat(children);
  const size = segmentSize === 'known' ? Buffer.concat([Buffer.from([0x01]), Buffer.from(body.length.toString(16).padStart(14, '0'), 'hex')]) : segmentSize;
  return Buffer.concat([ebmlHeader, Buffer.from('18538067', 'hex'), size, body]);
}

/** Duration in ms from a patched file (TimecodeScale 1 ms). */
function durationOf(buf) {
  const at = buf.indexOf(Buffer.from([0x44, 0x89, 0x88]));
  return at < 0 ? null : buf.readDoubleBE(at + 3);
}

test('the length is written into Segment › Info and the media data is untouched', () => {
  const file = webm();
  const { patched, restFrom } = patchHead(file, 12_345);
  const out = Buffer.concat([patched, file.subarray(restFrom)]);
  assert.equal(durationOf(out), 12_345);
  assert.equal(out.length, file.length + 7 + 11); // Info size widened to 8 bytes, plus the Duration element
  assert.ok(out.subarray(out.length - cluster.length).equals(cluster)); // clusters byte-identical
  assert.ok(out.includes(tracks));
  // Info's new size covers its old children plus Duration.
  const infoAt = out.indexOf(Buffer.from('1549a966', 'hex'));
  assert.equal(out.readUInt32BE(infoAt + 4 + 4), info().length - 4 - 1 + 11);
});

test('a Segment with a known size grows by the same amount', () => {
  const file = webm({ segmentSize: 'known' });
  const { patched, restFrom } = patchHead(file, 1000);
  const out = Buffer.concat([patched, file.subarray(restFrom)]);
  const segAt = out.indexOf(Buffer.from('18538067', 'hex'));
  const size = Number(out.readBigUInt64BE(segAt + 4) & 0x00ffffffffffffffn);
  assert.equal(size, out.length - (segAt + 12));
});

test('files it cannot patch safely are left alone', () => {
  assert.equal(patchHead(Buffer.from('not a webm at all'), 1000), null);
  assert.equal(patchHead(webm({ children: [info([el('4489', Buffer.alloc(8))]), tracks] }), 1000), null); // has a Duration
  assert.equal(patchHead(webm({ children: [el('114d9b74', Buffer.alloc(4)), info(), tracks] }), 1000), null); // SeekHead offsets
  assert.equal(patchHead(webm({ children: [cluster, info()] }), 1000), null); // no Info before the media
});

/** A frame on track 1 at `offset` ms into its cluster. */
const frame = (offset) => {
  const body = Buffer.alloc(3 + 20, 5);
  body[0] = 0x81; // track 1
  body.writeInt16BE(offset, 1);
  return el('a3', body);
};
/** A cluster starting at `timeMs`; `open` writes it with an unknown size, as Chrome does. */
const clusterAt = (timeMs, offsets, open = false) => {
  const time = Buffer.alloc(2);
  time.writeUInt16BE(timeMs);
  const body = Buffer.concat([el('e7', time), ...offsets.map(frame)]);
  return open ? Buffer.concat([Buffer.from('1f43b675', 'hex'), UNKNOWN, body]) : el('1f43b675', body, Buffer.concat([Buffer.from([0x40 | (body.length >> 8), body.length & 0xff])]));
};

test('the real length is read from the last frame in the file', async () => {
  const file = path.join(os.tmpdir(), `webm-length-${process.pid}.webm`);
  try {
    // Two live-stream clusters (unknown size, like MediaRecorder): frames up to 5,000 + 1,960 ms.
    await fs.writeFile(file, webm({ children: [info(), tracks, clusterAt(0, [0, 980, 1960], true), clusterAt(5000, [0, 1960, 1500], true)] }));
    assert.equal(await webmDurationMs(file), 6960);
    // Clusters with a known size work too, and a cut-off last frame is ignored.
    const complete = webm({ children: [info(), tracks, clusterAt(0, [0, 40]), clusterAt(2000, [0, 33])] });
    await fs.writeFile(file, Buffer.concat([complete, Buffer.from('a3', 'hex')]));
    assert.equal(await webmDurationMs(file), 2033);
    await fs.writeFile(file, Buffer.from('not a webm'));
    assert.equal(await webmDurationMs(file), null);
  } finally {
    await fs.unlink(file).catch(() => {});
  }
});

test('addWebmDuration patches the file in place, once', async () => {
  const file = path.join(os.tmpdir(), `webm-test-${process.pid}.webm`);
  await fs.writeFile(file, webm());
  try {
    assert.equal(await addWebmDuration(file, 4200), true);
    assert.equal(durationOf(await fs.readFile(file)), 4200);
    assert.equal(await addWebmDuration(file, 9999), false); // already has one
    assert.equal(durationOf(await fs.readFile(file)), 4200);
  } finally {
    await fs.unlink(file).catch(() => {});
  }
});
