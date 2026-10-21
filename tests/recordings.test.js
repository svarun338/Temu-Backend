import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { auth, closeAll, connectUsers, emitAck, expectNoEvent, fakeS3, pool, readStoredFile, registerUser, resetDatabase, startServer, storedFileExists, waitFor } from './helpers.js';
import { config } from '../src/config/index.js';
import { parseRange } from '../src/controllers/recordingController.js';
import { createS3Storage, objectStorage } from '../src/services/objectStorage.js';

let server;
let request;
let alice;
let bob;
let eve;
let aliceBob;
let open = [];
let current = null; // the call a test connected, hung up before the next test

const tab = (name) => `${name}-tab-0123456789`;
const KEY_PATTERN = /^recordings\/\d{4}\/\d{2}\/conversation-\d+\/call-\d+\/\d+-[a-f0-9]{8}\.(webm|ogg|m4a|mp4)$/;

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice Recorder' });
  bob = await registerUser(request, { name: 'Bob Listener' });
  eve = await registerUser(request, { name: 'Eve Outsider' });
  aliceBob = await connectUsers(request, alice, bob);
});

beforeEach(async () => {
  if (current) await emitAck(current.a, 'call:end', { callId: current.callId }).catch(() => {});
  current = null;
  for (const socket of open) socket.disconnect();
  open = [];
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the server notice the hang-ups
});

after(async () => {
  await server.close();
  await closeAll();
});

async function connect(user, name) {
  const socket = await server.connect(user.token, { auth: { token: user.token, tabId: tab(name) } });
  open.push(socket);
  return socket;
}

/** Alice calls Bob, Bob answers: returns the sockets and the call id. */
async function connectedCall(type = 'video') {
  const a = await connect(alice, 'alice');
  const b = await connect(bob, 'bob');
  const ringing = waitFor(b, 'call:incoming');
  const started = await emitAck(a, 'call:start', { conversationId: aliceBob.id, type });
  assert.equal(started.ok, true, JSON.stringify(started.error));
  await ringing;
  const accepted = waitFor(a, 'call:accepted');
  assert.equal((await emitAck(b, 'call:accept', { callId: started.data.call.id })).ok, true);
  await accepted;
  current = { a, b, callId: started.data.call.id };
  return current;
}

const startRecording = (user, callId, body = { kind: 'video', mimeType: 'video/webm;codecs=vp8,opus' }) =>
  request.post(`/api/calls/${callId}/recordings`).set(auth(user.token)).send(body);

const sendChunk = (user, recordingId, seq, bytes) =>
  request
    .put(`/api/recordings/${recordingId}/chunks/${seq}`)
    .set(auth(user.token))
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);

const finish = (user, recordingId, durationMs = 4000) =>
  request.post(`/api/recordings/${recordingId}/finish`).set(auth(user.token)).send({ durationMs });

const download = (user, recordingId) => request.get(`/api/attachments/recordings/${recordingId}`).set(auth(user.token)).buffer(true).parse(binary);

/** supertest: collect any body as a Buffer. */
function binary(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

const bytes = (fill, size) => Buffer.alloc(size, fill);

describe('starting a recording', () => {
  test('only a connected call can be recorded, and only by its two people', async () => {
    const a = await connect(alice, 'alice');
    const b = await connect(bob, 'bob');
    const ringing = waitFor(b, 'call:incoming');
    const started = await emitAck(a, 'call:start', { conversationId: aliceBob.id, type: 'video' });
    await ringing;
    const callId = started.data.call.id;

    const res = await startRecording(alice, callId).expect(409);
    assert.equal(res.body.error.code, 'CALL_NOT_CONNECTED');
    await emitAck(a, 'call:end', { callId });
    await startRecording(alice, 999999).expect(404);

    const call = await connectedCall('video');
    await startRecording(eve, call.callId).expect(404);
    await request.post(`/api/calls/${call.callId}/recordings`).send({ kind: 'video', mimeType: 'video/webm' }).expect(401);
  });

  test('voice calls are recorded as audio, and only known formats are accepted', async () => {
    const { callId } = await connectedCall('voice');
    assert.equal((await startRecording(alice, callId, { kind: 'video', mimeType: 'video/webm' }).expect(400)).body.error.code, 'BAD_REQUEST');
    assert.equal((await startRecording(alice, callId, { kind: 'audio', mimeType: 'video/webm' }).expect(415)).body.error.code, 'UNSUPPORTED_FILE');
    assert.equal((await startRecording(alice, callId, { kind: 'audio', mimeType: 'audio/x-wav' }).expect(415)).body.error.code, 'UNSUPPORTED_FILE');
    await startRecording(alice, callId, { kind: 'audio', mimeType: 'audio/webm;codecs=opus' }).expect(201);
  });

  test('the other person is told at once, and nobody can record twice at the same time', async () => {
    const { b, callId } = await connectedCall('video');
    const told = waitFor(b, 'call:recording', (e) => e.recording === true);
    const { body } = await startRecording(alice, callId).expect(201);
    assert.equal(body.recording.status, 'recording');
    assert.equal(body.recording.mimeType, 'video/webm'); // codecs are dropped
    assert.equal(body.recording.url, `/api/attachments/recordings/${body.recording.id}`);
    const event = await told;
    assert.deepEqual(event, { callId, recordingId: body.recording.id, userId: alice.user.id, kind: 'video', recording: true });

    assert.equal((await startRecording(alice, callId).expect(409)).body.error.code, 'ALREADY_RECORDING');
  });
});

describe('the host', () => {
  test('the person who started the call is the host, and only the host can record', async () => {
    const a = await connect(alice, 'alice');
    const b = await connect(bob, 'bob');
    const ringing = waitFor(b, 'call:incoming');
    const started = await emitAck(a, 'call:start', { conversationId: aliceBob.id, type: 'video' });
    assert.equal(started.data.call.hostId, alice.user.id);
    assert.equal((await ringing).call.hostId, alice.user.id);
    const accepted = waitFor(a, 'call:accepted');
    const answer = await emitAck(b, 'call:accept', { callId: started.data.call.id });
    assert.equal(answer.data.call.hostId, alice.user.id);
    await accepted;
    current = { a, b, callId: started.data.call.id };

    const refused = await startRecording(bob, current.callId).expect(403);
    assert.equal(refused.body.error.code, 'NOT_HOST');
    await startRecording(alice, current.callId).expect(201);
  });

  test('when the host drops, the next person who joined becomes host; the old host does not take it back', async () => {
    const { a, b, callId } = await connectedCall('video');
    const { recording } = (await startRecording(alice, callId).expect(201)).body;
    await sendChunk(alice, recording.id, 0, bytes(6, 400)).expect(200);

    const handover = waitFor(b, 'call:host');
    const stoppedRecording = waitFor(b, 'call:recording', (e) => e.recording === false && e.recordingId === recording.id, 500);
    const savedNote = waitFor(b, 'message:new', (m) => m.event?.data?.recordingId === recording.id, 2000);
    a.disconnect(); // Alice's connection drops (the call survives for CALL_RECONNECT_GRACE_SECONDS)
    assert.deepEqual(await handover, { callId, hostId: bob.user.id, previousHostId: alice.user.id });
    await stoppedRecording; // Bob's "Alice is recording" goes away at once

    // Her recording ends at that same moment: saved with what had arrived, nothing more accepted.
    // (Her browser may have kept capturing while offline; that must not end up in the file.)
    const saved = await savedNote;
    assert.equal(saved.senderId, alice.user.id);
    assert.equal((await sendChunk(alice, recording.id, 1, bytes(6, 10)).expect(409)).body.error.code, 'RECORDING_FINISHED');
    const [[stored]] = await pool.query('SELECT status, size_bytes FROM call_recordings WHERE id = ?', [recording.id]);
    assert.deepEqual({ status: stored.status, size: Number(stored.size_bytes) }, { status: 'ready', size: 400 });

    const bobRecording = (await startRecording(bob, callId).expect(201)).body.recording;
    assert.equal(bobRecording.recorder.id, bob.user.id);

    // Alice is back within the grace period: still in the call, no longer host.
    let resumed;
    const back = await server.connect(alice.token, {
      auth: { token: alice.token, tabId: tab('alice') },
      onSocket: (socket) => (resumed = waitFor(socket, 'call:resumed')),
    });
    open.push(back);
    assert.deepEqual(await resumed, { callId, hostId: bob.user.id });
    current = { a: back, b, callId };
    assert.equal((await startRecording(alice, callId).expect(403)).body.error.code, 'NOT_HOST');

    // And if Bob (now host) drops, the role moves on to the next connected person: Alice.
    const again = waitFor(back, 'call:host');
    b.disconnect();
    assert.deepEqual(await again, { callId, hostId: alice.user.id, previousHostId: bob.user.id });
    await startRecording(alice, callId).expect(201);
  });

  test('a non-host who drops changes nothing', async () => {
    const { a, b, callId } = await connectedCall('voice');
    const noHandover = expectNoEvent(a, 'call:host', 300);
    b.disconnect();
    await noHandover;
    await startRecording(alice, callId, { kind: 'audio', mimeType: 'audio/webm' }).expect(201);
  });
});

describe('uploading chunks', () => {
  test('chunks are appended in order; a retried chunk is accepted once; gaps are refused', async () => {
    const { callId } = await connectedCall('video');
    const { recording } = (await startRecording(alice, callId).expect(201)).body;

    assert.deepEqual((await sendChunk(alice, recording.id, 0, bytes(1, 1000)).expect(200)).body, { nextSeq: 1, sizeBytes: 1000 });
    assert.deepEqual((await sendChunk(alice, recording.id, 0, bytes(1, 1000)).expect(200)).body, { nextSeq: 1, sizeBytes: 1000 });
    const gap = await sendChunk(alice, recording.id, 2, bytes(3, 10)).expect(409);
    assert.equal(gap.body.error.code, 'CHUNK_OUT_OF_ORDER');
    assert.deepEqual(gap.body.error.details, { expected: 1 });
    assert.deepEqual((await sendChunk(alice, recording.id, 1, bytes(2, 500)).expect(200)).body, { nextSeq: 2, sizeBytes: 1500 });

    const [[row]] = await pool.query('SELECT next_seq, size_bytes, status FROM call_recordings WHERE id = ?', [recording.id]);
    assert.deepEqual({ ...row, size_bytes: Number(row.size_bytes) }, { next_seq: 2, size_bytes: 1500, status: 'recording' });
  });

  test('only the recorder can upload, as binary, within the size limit', async () => {
    const { callId } = await connectedCall('video');
    const { recording } = (await startRecording(alice, callId).expect(201)).body;
    await sendChunk(bob, recording.id, 0, bytes(1, 10)).expect(404);
    await sendChunk(eve, recording.id, 0, bytes(1, 10)).expect(404);
    await request.put(`/api/recordings/${recording.id}/chunks/0`).set(auth(alice.token)).send({ not: 'binary' }).expect(415);
    await sendChunk(alice, recording.id, 0, Buffer.alloc(0)).expect(400);

    // MAX_RECORDING_MB is 1 in tests.
    await sendChunk(alice, recording.id, 0, bytes(1, 700 * 1024)).expect(200);
    const tooBig = await sendChunk(alice, recording.id, 1, bytes(1, 400 * 1024)).expect(413);
    assert.equal(tooBig.body.error.code, 'RECORDING_TOO_LARGE');
  });

  test('chunks sent at the same moment still end up in order', async () => {
    const { callId } = await connectedCall('video');
    const { recording } = (await startRecording(alice, callId).expect(201)).body;
    // Sent together, out of order: only the expected one is taken each time, the client retries the rest.
    const results = await Promise.all([2, 0, 1].map((seq) => sendChunk(alice, recording.id, seq, bytes(seq + 1, 10))));
    const accepted = results.filter((res) => res.status === 200).length;
    assert.ok(accepted >= 1);
    let next = (await pool.query('SELECT next_seq FROM call_recordings WHERE id = ?', [recording.id]))[0][0].next_seq;
    while (next < 3) {
      await sendChunk(alice, recording.id, next, bytes(next + 1, 10)).expect(200);
      next += 1;
    }
    await finish(alice, recording.id).expect(200);
    const { body } = await download(alice, recording.id).expect(200);
    assert.deepEqual(body, Buffer.concat([bytes(1, 10), bytes(2, 10), bytes(3, 10)]));
  });
});

describe('saving and playing', () => {
  test('finishing stores the file under recordings/…, tells both people and posts it in the chat', async () => {
    const { a, b, callId } = await connectedCall('video');
    const { recording } = (await startRecording(alice, callId).expect(201)).body;
    await sendChunk(alice, recording.id, 0, bytes(7, 2000)).expect(200);
    await sendChunk(alice, recording.id, 1, bytes(8, 1000)).expect(200);

    const stopped = waitFor(b, 'call:recording', (e) => e.recording === false);
    const aliceNote = waitFor(a, 'message:new', (m) => m.event?.data?.recordingId === recording.id);
    const bobNote = waitFor(b, 'message:new', (m) => m.event?.data?.recordingId === recording.id);
    const { body } = await finish(alice, recording.id, 3200).expect(200);
    assert.equal(body.recording.status, 'ready');
    assert.equal(body.recording.durationMs, 3200);
    assert.equal(body.recording.sizeBytes, 3000);
    await stopped;
    const note = await bobNote;
    await aliceNote;
    assert.equal(note.senderId, alice.user.id);
    assert.deepEqual(note.event.data, {
      recordingId: recording.id,
      callId,
      kind: 'video',
      mimeType: 'video/webm',
      durationSec: 3,
      recorderId: alice.user.id,
      url: `/api/attachments/recordings/${recording.id}`,
    });

    const [[row]] = await pool.query('SELECT status, storage_driver, storage_key FROM call_recordings WHERE id = ?', [recording.id]);
    assert.equal(row.status, 'ready');
    assert.equal(row.storage_driver, objectStorage.current.name); // 'local', or 's3' with TEST_STORAGE=s3
    assert.match(row.storage_key, KEY_PATTERN);
    assert.ok(row.storage_key.includes(`/conversation-${aliceBob.id}/call-${callId}/${recording.id}-`));
    const stored = await readStoredFile(row.storage_key);
    assert.equal(stored.length, 3000);
    await assert.rejects(fs.access(path.join(config.uploads.dir, 'tmp', `recording-${recording.id}.part`))); // temp file gone

    // Finishing again changes nothing; no more chunks are taken.
    assert.equal((await finish(alice, recording.id).expect(200)).body.recording.durationMs, 3200);
    assert.equal((await sendChunk(alice, recording.id, 2, bytes(1, 10)).expect(409)).body.error.code, 'RECORDING_FINISHED');
  });

  test('both people can play it (with seeking); nobody else can', async () => {
    const { callId } = await connectedCall('voice');
    const { recording } = (await startRecording(alice, callId, { kind: 'audio', mimeType: 'audio/webm;codecs=opus' }).expect(201)).body;
    const content = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    await sendChunk(alice, recording.id, 0, content).expect(200);
    await finish(alice, recording.id).expect(200);

    const whole = await download(alice, recording.id).expect(200);
    assert.deepEqual(whole.body, content);
    assert.equal(whole.headers['content-type'], 'audio/webm');
    assert.equal(whole.headers['accept-ranges'], 'bytes');
    assert.match(whole.headers['content-disposition'], /^inline; filename="call-recording-\d{4}-\d{2}-\d{2}-\d+\.webm"$/);
    assert.equal(whole.headers['cache-control'], 'private, max-age=3600');
    assert.deepEqual((await download(bob, recording.id).expect(200)).body, content);

    const part = await download(alice, recording.id).set('Range', 'bytes=100-199').expect(206);
    assert.deepEqual(part.body, content.subarray(100, 200));
    assert.equal(part.headers['content-range'], 'bytes 100-199/1000');
    const tail = await download(alice, recording.id).set('Range', 'bytes=-10').expect(206);
    assert.deepEqual(tail.body, content.subarray(990));
    await download(alice, recording.id).set('Range', 'bytes=5000-').expect(416);

    await download(eve, recording.id).expect(404);
    await request.get(`/api/attachments/recordings/${recording.id}`).expect(401);
    const asFile = await request.get(`/api/attachments/recordings/${recording.id}?download=1`).set(auth(alice.token)).expect(200);
    assert.match(asFile.headers['content-disposition'], /^attachment;/);

    const list = await request.get(`/api/calls/${callId}/recordings`).set(auth(alice.token)).expect(200);
    assert.deepEqual(list.body.recordings.map((r) => r.id), [recording.id]);
    await request.get(`/api/calls/${callId}/recordings`).set(auth(eve.token)).expect(404);
  });

  test('the media cookie plays recordings in <audio>/<video>', async () => {
    const login = await request.post('/api/auth/login').send({ email: alice.user.email, password: alice.password }).expect(200);
    const media = login.headers['set-cookie'].find((c) => c.startsWith('temu_media='));
    assert.ok(media);
    const { callId } = await connectedCall('voice');
    const { recording } = (await startRecording(alice, callId, { kind: 'audio', mimeType: 'audio/ogg' }).expect(201)).body;
    await sendChunk(alice, recording.id, 0, bytes(5, 20)).expect(200);
    await finish(alice, recording.id).expect(200);
    await request.get(`/api/attachments/recordings/${recording.id}`).set('Cookie', media.split(';')[0]).expect(200);
  });

  test('hanging up saves a recording that was never stopped', async () => {
    const { a, b, callId } = await connectedCall('video');
    const { recording } = (await startRecording(alice, callId).expect(201)).body;
    await sendChunk(alice, recording.id, 0, bytes(9, 300)).expect(200);

    const note = waitFor(b, 'message:new', (m) => m.event?.data?.recordingId === recording.id, 4000);
    await emitAck(a, 'call:end', { callId });
    // The recorder's last chunk may still arrive after the call ended.
    await sendChunk(alice, recording.id, 1, bytes(9, 200)).expect(200);
    const message = await note; // RECORDING_FINALIZE_SECONDS = 1 in tests
    assert.equal(message.event.data.recordingId, recording.id);
    const [[row]] = await pool.query('SELECT status, size_bytes FROM call_recordings WHERE id = ?', [recording.id]);
    assert.deepEqual({ status: row.status, size: Number(row.size_bytes) }, { status: 'ready', size: 500 });
  });

  test('an empty recording is discarded without a chat note', async () => {
    const { b, callId } = await connectedCall('video');
    const { recording } = (await startRecording(alice, callId).expect(201)).body;
    const silent = expectNoEvent(b, 'message:new', 400);
    const { body } = await finish(alice, recording.id).expect(200);
    assert.equal(body.recording, null);
    await silent;
    const [rows] = await pool.query('SELECT id FROM call_recordings WHERE id = ?', [recording.id]);
    assert.equal(rows.length, 0);
  });

  test('the recorder can delete it: the file is removed for both people', async () => {
    const { b, callId } = await connectedCall('video');
    const { recording } = (await startRecording(alice, callId).expect(201)).body;
    await request.delete(`/api/recordings/${recording.id}`).set(auth(alice.token)).expect(409); // still recording
    await sendChunk(alice, recording.id, 0, bytes(4, 100)).expect(200);
    await finish(alice, recording.id).expect(200);
    const [[row]] = await pool.query('SELECT storage_key FROM call_recordings WHERE id = ?', [recording.id]);

    await request.delete(`/api/recordings/${recording.id}`).set(auth(bob.token)).expect(404);
    const gone = waitFor(b, 'recording:deleted');
    await request.delete(`/api/recordings/${recording.id}`).set(auth(alice.token)).expect(204);
    assert.deepEqual(await gone, { recordingId: recording.id, conversationId: aliceBob.id });
    assert.equal(await storedFileExists(row.storage_key), false);
    await download(bob, recording.id).expect(404);
  });
});

describe('S3 storage', () => {
  test('the S3 driver stores privately-encrypted objects under the prefix, reads ranges and deletes', async () => {
    const client = fakeS3();
    const s3 = createS3Storage({ bucket: 'temu-media-prod', prefix: 'prod/', client });
    const temp = path.join(config.uploads.dir, 'tmp', 'unit-s3.part');
    await fs.mkdir(path.dirname(temp), { recursive: true });
    await fs.writeFile(temp, Buffer.from('hello recording'));

    await s3.put('recordings/2026/10/conversation-1/call-2/3-abcd1234.webm', temp, 'video/webm');
    const put = client.calls.find((c) => c.name === 'PutObjectCommand').input;
    assert.equal(put.Bucket, 'temu-media-prod');
    assert.equal(put.Key, 'prod/recordings/2026/10/conversation-1/call-2/3-abcd1234.webm');
    assert.equal(put.ServerSideEncryption, 'AES256');
    assert.equal(put.ContentType, 'video/webm');
    assert.equal(put.ContentLength, 15);
    await assert.rejects(fs.access(temp)); // temp file removed after upload

    const chunks = [];
    for await (const chunk of await s3.read('recordings/2026/10/conversation-1/call-2/3-abcd1234.webm', { start: 6, end: 14 })) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'recording');
    await assert.rejects(s3.read('recordings/missing.webm'), (error) => error.code === 'ENOENT');
    await s3.remove('recordings/2026/10/conversation-1/call-2/3-abcd1234.webm');
    assert.equal(client.objects.size, 0);
    await assert.rejects(s3.put('../etc/passwd', temp, 'text/plain'), /Invalid storage key/);
  });

  test('a whole call recording goes to S3 and plays back from there, even after switching back to disk', async () => {
    const client = fakeS3();
    const before = objectStorage.snapshot();
    objectStorage.useDriver('s3', createS3Storage({ bucket: 'temu-media-prod', prefix: '', client }), { current: true });
    try {
      const { callId } = await connectedCall('video');
      const { recording } = (await startRecording(alice, callId).expect(201)).body;
      await sendChunk(alice, recording.id, 0, bytes(1, 400)).expect(200);
      await sendChunk(alice, recording.id, 1, bytes(2, 400)).expect(200);
      await finish(alice, recording.id).expect(200);

      const [[row]] = await pool.query('SELECT storage_driver, storage_key FROM call_recordings WHERE id = ?', [recording.id]);
      assert.equal(row.storage_driver, 's3');
      assert.match(row.storage_key, KEY_PATTERN);
      assert.equal(client.objects.get(row.storage_key).body.length, 800);
      assert.equal(client.objects.get(row.storage_key).contentType, 'video/webm');

      objectStorage.useDriver('local', null, { current: true }); // new files go to disk again…
      const played = await download(bob, recording.id).set('Range', 'bytes=390-409').expect(206);
      assert.deepEqual(played.body, Buffer.concat([bytes(1, 10), bytes(2, 10)])); // …old ones still come from S3
    } finally {
      objectStorage.restore(before);
    }
  });
});

describe('byte ranges', () => {
  test('parseRange understands the forms players send', () => {
    assert.equal(parseRange(undefined, 100), null);
    assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
    assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-30', 100), { start: 70, end: 99 });
    assert.equal(parseRange('bytes=100-', 100), false);
    assert.equal(parseRange('bytes=20-10', 100), false);
    assert.equal(parseRange('bytes=0-1,5-9', 100), null);
    assert.equal(parseRange('items=0-1', 100), null);
  });
});
