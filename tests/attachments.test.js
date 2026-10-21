import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { auth, closeAll, connectUsers, emitAck, pool, registerUser, resetDatabase, startServer, storedFileExists, waitFor } from './helpers.js';

let server;
let request;
let alice;
let bob;
let carol;
let ab;
let ac;
let attachmentStorage;
let attachmentService;

const bytes = (...values) => Buffer.from(values);
const PNG = Buffer.concat([bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), Buffer.alloc(2048, 7)]);
const JPG = Buffer.concat([bytes(0xff, 0xd8, 0xff, 0xe0), Buffer.alloc(512, 1)]);
const MP4 = Buffer.concat([bytes(0, 0, 0, 0x20), Buffer.from('ftypisom'), Buffer.alloc(4096, 3)]);
const WEBM = Buffer.concat([bytes(0x1a, 0x45, 0xdf, 0xa3), Buffer.alloc(1024, 2)]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF');
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(256)]);

before(async () => {
  await resetDatabase();
  ({ attachmentStorage } = await import('../src/services/attachmentStorage.js'));
  ({ attachmentService } = await import('../src/services/attachmentService.js'));
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice Files' });
  bob = await registerUser(request, { name: 'Bob Files' });
  carol = await registerUser(request, { name: 'Carol Files' });
  ab = await connectUsers(request, alice, bob);
  ac = await connectUsers(request, alice, carol);
});

after(async () => {
  await server.close();
  await closeAll();
});

function upload(user, conversation, buffer, filename, fields = {}) {
  let req = request.post('/api/attachments').set(auth(user.token)).field('conversationId', String(conversation.id));
  for (const [key, value] of Object.entries(fields)) req = req.field(key, String(value));
  return req.attach('file', buffer, filename);
}

async function sendWith(user, conversation, attachmentIds, body = '') {
  const res = await request
    .post(`/api/conversations/${conversation.id}/messages`)
    .set(auth(user.token))
    .send({ body, attachmentIds })
    .expect(201);
  return res.body.message;
}

const mediaCookie = (user) => `temu_media=${user.token}`;

describe('uploading', () => {
  test('detects the real type from the content and stores it under a random name', async () => {
    const res = await upload(alice, ab, PNG, 'holiday.jpg', { width: 800, height: 600 }).expect(201);
    const a = res.body.attachment;
    assert.equal(a.kind, 'image');
    assert.equal(a.mimeType, 'image/png', 'the content wins over the .jpg name');
    assert.equal(a.name, 'holiday.jpg');
    assert.equal(a.size, PNG.length);
    assert.deepEqual([a.width, a.height], [800, 600]);
    assert.equal(a.url, `/api/attachments/${a.id}`);

    const [rows] = await pool.query('SELECT storage_key FROM attachments WHERE id = ?', [a.id]);
    assert.match(rows[0].storage_key, /^[a-f0-9]{32}$/);
    assert.equal(await storedFileExists(attachmentStorage.objectKey(rows[0].storage_key)), true);
  });

  test('blocks programs, by content and by extension', async () => {
    const disguised = await upload(alice, ab, EXE, 'cute-cat.jpg').expect(415);
    assert.equal(disguised.body.error.code, 'BLOCKED_FILE_TYPE');
    await upload(alice, ab, Buffer.from('echo hi'), 'run.bat').expect(415);
    await upload(alice, ab, Buffer.from('alert(1)'), 'evil.js').expect(415);
  });

  test('enforces size limits per kind', async () => {
    const bigImage = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]); // test limit: 1 MB for images
    const res = await upload(alice, ab, bigImage, 'big.png').expect(413);
    assert.equal(res.body.error.code, 'FILE_TOO_LARGE');
    // The same bytes are fine as a document (100 MB limit).
    await upload(alice, ab, bigImage, 'big.png', { kind: 'file' }).expect(201);
  });

  test('voice notes must be audio', async () => {
    const voice = await upload(alice, ab, WEBM, 'voice.webm', { kind: 'voice', durationMs: 4200 }).expect(201);
    assert.equal(voice.body.attachment.kind, 'voice');
    assert.equal(voice.body.attachment.mimeType, 'audio/webm');
    assert.equal(voice.body.attachment.durationMs, 4200);
    await upload(alice, ab, PNG, 'not-audio.png', { kind: 'voice' }).expect(415);
  });

  test('only participants can upload, and never across a block', async () => {
    await upload(carol, ab, PNG, 'x.png').expect(404);
    await request.post('/api/blocks').set(auth(bob.token)).send({ userId: alice.user.id }).expect(201);
    await upload(alice, ab, PNG, 'x.png').expect(403);
    await request.delete(`/api/blocks/${alice.user.id}`).set(auth(bob.token)).expect(204);
  });

  test('rejects missing files and bad fields, and leaves no temp files behind', async () => {
    await request.post('/api/attachments').set(auth(alice.token)).field('conversationId', String(ab.id)).expect(400);
    await upload(alice, ab, PNG, 'x.png', { width: -5 }).expect(422);
    await request.post('/api/attachments').attach('file', PNG, 'x.png').expect(401);
    const temp = await fs.readdir((await import('../src/services/attachmentStorage.js')).TEMP_DIR);
    assert.equal(temp.length, 0);
  });
});

describe('sending', () => {
  test('an album with a caption arrives live with its attachments', async () => {
    const one = (await upload(alice, ab, PNG, 'a.png').expect(201)).body.attachment;
    const two = (await upload(alice, ab, JPG, 'b.jpg').expect(201)).body.attachment;
    const bobSocket = await server.connect(bob.token);
    const received = waitFor(bobSocket, 'message:new', (m) => m.attachments?.length === 2);

    const message = await sendWith(alice, ab, [one.id, two.id], 'Our trip');
    assert.equal(message.body, 'Our trip');
    assert.deepEqual(message.attachments.map((a) => a.id), [one.id, two.id]);
    assert.equal((await received).attachments[1].name, 'b.jpg');
    bobSocket.disconnect();
  });

  test('a message may be just files, sent over sockets too', async () => {
    const file = (await upload(alice, ab, PDF, 'report.pdf').expect(201)).body.attachment;
    const socket = await server.connect(alice.token);
    const ack = await emitAck(socket, 'message:send', { conversationId: ab.id, attachmentIds: [file.id] });
    assert.equal(ack.ok, true);
    assert.equal(ack.data.message.body, '');
    assert.equal(ack.data.message.attachments[0].mimeType, 'application/pdf');
    socket.disconnect();
  });

  test("cannot attach someone else's upload, an upload from another chat, or reuse one", async () => {
    const bobs = (await upload(bob, ab, PNG, 'bob.png').expect(201)).body.attachment;
    await request.post(`/api/conversations/${ab.id}/messages`).set(auth(alice.token)).send({ attachmentIds: [bobs.id] }).expect(400);

    const elsewhere = (await upload(alice, ac, PNG, 'carol-chat.png').expect(201)).body.attachment;
    await request.post(`/api/conversations/${ab.id}/messages`).set(auth(alice.token)).send({ attachmentIds: [elsewhere.id] }).expect(400);

    const mine = (await upload(alice, ab, PNG, 'once.png').expect(201)).body.attachment;
    await sendWith(alice, ab, [mine.id]);
    await request.post(`/api/conversations/${ab.id}/messages`).set(auth(alice.token)).send({ attachmentIds: [mine.id] }).expect(400);
  });

  test('empty messages are rejected and the chat preview summarises attachments', async () => {
    await request.post(`/api/conversations/${ab.id}/messages`).set(auth(alice.token)).send({}).expect(422);
    const voice = (await upload(alice, ab, WEBM, 'v.webm', { kind: 'voice', durationMs: 9000 }).expect(201)).body.attachment;
    await sendWith(alice, ab, [voice.id]);
    const list = (await request.get('/api/conversations').set(auth(bob.token)).expect(200)).body.conversations;
    const summary = list.find((c) => c.id === ab.id).lastMessage.attachmentSummary;
    assert.deepEqual(summary, { kind: 'voice', count: 1, durationMs: 9000, name: 'v.webm' });
  });
});

describe('downloading', () => {
  let photo;
  let pdf;

  before(async () => {
    photo = (await upload(alice, ab, PNG, 'photo.png').expect(201)).body.attachment;
    pdf = (await upload(alice, ab, PDF, 'notes "final".pdf').expect(201)).body.attachment;
    await sendWith(alice, ab, [photo.id, pdf.id]);
  });

  test('participants can download with a bearer token or the media cookie', async () => {
    const viaHeader = await request.get(photo.url).set(auth(bob.token)).expect(200);
    assert.equal(viaHeader.headers['content-type'], 'image/png');
    assert.ok(Buffer.compare(viaHeader.body, PNG) === 0);
    assert.equal(viaHeader.headers['x-content-type-options'], 'nosniff');
    assert.match(viaHeader.headers['content-security-policy'], /sandbox/);
    assert.match(viaHeader.headers['cache-control'], /private/);

    await request.get(photo.url).set('Cookie', mediaCookie(bob)).expect(200);
  });

  test('outsiders and anonymous users cannot', async () => {
    await request.get(photo.url).set(auth(carol.token)).expect(404);
    await request.get(photo.url).set('Cookie', mediaCookie(carol)).expect(404);
    await request.get(photo.url).expect(401);
    await request.get(photo.url).set('Cookie', 'temu_media=forged.token.here').expect(401);
    await request.get('/api/attachments/999999').set(auth(bob.token)).expect(404);
  });

  test('unsent uploads are visible only to their uploader', async () => {
    const draft = (await upload(alice, ab, PNG, 'draft.png').expect(201)).body.attachment;
    await request.get(draft.url).set(auth(alice.token)).expect(200);
    await request.get(draft.url).set(auth(bob.token)).expect(404);
  });

  test('supports range requests (video seeking) and forced downloads with a safe file name', async () => {
    const partial = await request.get(photo.url).set(auth(bob.token)).set('Range', 'bytes=0-7').expect(206);
    assert.equal(partial.headers['content-range'], `bytes 0-7/${PNG.length}`);

    const download = await request.get(`${pdf.url}?download=1`).set(auth(bob.token)).expect(200);
    assert.match(download.headers['content-disposition'], /^attachment; filename="notes _final_.pdf"; filename\*=UTF-8''/);
  });

  test('unknown types are never served inline', async () => {
    const html = (await upload(alice, ab, Buffer.from('<html><script>alert(1)</script></html>'), 'page.html').expect(201)).body.attachment;
    await sendWith(alice, ab, [html.id]);
    const res = await request.get(html.url).set(auth(bob.token)).expect(200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.match(res.headers['content-disposition'], /^attachment;/);
  });
});

describe('lifecycle', () => {
  test('delete for everyone removes the files', async () => {
    const photo = (await upload(alice, ab, PNG, 'gone.png').expect(201)).body.attachment;
    const message = await sendWith(alice, ab, [photo.id]);
    const [[row]] = await pool.query('SELECT storage_key FROM attachments WHERE id = ?', [photo.id]);

    const res = await request.delete(`/api/messages/${message.id}?scope=everyone`).set(auth(alice.token)).expect(200);
    assert.deepEqual(res.body.message.attachments, []);
    await request.get(photo.url).set(auth(bob.token)).expect(404);
    assert.equal(await storedFileExists(attachmentStorage.objectKey(row.storage_key)), false);
  });

  test('forwarded files survive deletion of the original', async () => {
    const photo = (await upload(alice, ab, PNG, 'shared.png').expect(201)).body.attachment;
    const original = await sendWith(alice, ab, [photo.id]);
    const fwd = await request.post(`/api/messages/${original.id}/forward`).set(auth(alice.token)).send({ conversationIds: [ac.id] }).expect(201);
    const copy = fwd.body.messages[0].attachments[0];
    assert.notEqual(copy.id, photo.id);

    await request.delete(`/api/messages/${original.id}?scope=everyone`).set(auth(alice.token)).expect(200);
    const res = await request.get(copy.url).set(auth(carol.token)).expect(200);
    assert.ok(Buffer.compare(res.body, PNG) === 0);
  });

  test('uploads never sent are cleaned up after a day', async () => {
    const stale = (await upload(alice, ab, PNG, 'stale.png').expect(201)).body.attachment;
    const [[row]] = await pool.query('SELECT storage_key FROM attachments WHERE id = ?', [stale.id]);
    await pool.query('UPDATE attachments SET created_at = NOW(3) - INTERVAL 25 HOUR WHERE id = ?', [stale.id]);
    assert.ok((await attachmentService.deleteOrphans()) >= 1);
    assert.equal(await storedFileExists(attachmentStorage.objectKey(row.storage_key)), false);
  });
});

describe('gallery', () => {
  test('lists media, files and audio separately, hiding deleted-for-me messages', async () => {
    const media = (await request.get(`/api/conversations/${ab.id}/attachments?type=media`).set(auth(bob.token)).expect(200)).body.items;
    assert.ok(media.length > 0 && media.every((a) => a.kind === 'image' || a.kind === 'video'));
    const files = (await request.get(`/api/conversations/${ab.id}/attachments?type=files`).set(auth(bob.token)).expect(200)).body.items;
    assert.ok(files.some((a) => a.mimeType === 'application/pdf'));
    const audio = (await request.get(`/api/conversations/${ab.id}/attachments?type=audio`).set(auth(bob.token)).expect(200)).body.items;
    assert.ok(audio.every((a) => a.kind === 'voice' || a.kind === 'audio'));

    const target = media[0];
    await request.delete(`/api/messages/${target.messageId}?scope=me`).set(auth(bob.token)).expect(200);
    const after = (await request.get(`/api/conversations/${ab.id}/attachments?type=media`).set(auth(bob.token))).body.items;
    assert.ok(!after.some((a) => a.id === target.id));

    await request.get(`/api/conversations/${ab.id}/attachments?type=media`).set(auth(carol.token)).expect(404);
    await request.get(`/api/conversations/${ab.id}/attachments?type=all`).set(auth(bob.token)).expect(422);
  });
});
