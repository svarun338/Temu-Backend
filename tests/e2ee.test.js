import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as e2ee from '../../temy_frontend/src/e2ee/crypto.js';
import { auth, closeAll, connectUsers, emitAck, pool, registerUser, resetDatabase, startServer, waitFor } from './helpers.js';

let server;
let request;
let config;
let alice;
let bob;
let carol; // outsider
let chat;

/** A device: keys made with the real client crypto, registered on the server. */
async function newDevice(user, name = 'Test browser') {
  const keys = await e2ee.generateDeviceKeys();
  const publicKey = await e2ee.exportPublicKey(keys.publicKey);
  const res = await request.post('/api/e2ee/devices').set(auth(user.token)).send({ publicKey, name }).expect(201);
  return { id: res.body.device.id, publicKey, privateKey: keys.privateKey, userId: user.user.id, user };
}

const devicesOf = async (user, conversationId) =>
  (await request.get(`/api/e2ee/conversations/${conversationId}/devices`).set(auth(user.token)).expect(200)).body.devices;

async function encryptFor(device, conversationId, content, devices) {
  const { encrypted } = await e2ee.encryptContent({
    content,
    conversationId,
    me: { userId: device.userId, deviceId: device.id, privateKey: device.privateKey },
    devices: devices ?? (await devicesOf(device.user, conversationId)),
  });
  return encrypted;
}

const read = (message, device) =>
  e2ee
    .decryptContent({ e2ee: message.e2ee, conversationId: message.conversationId, senderId: message.senderId, me: { deviceId: device.id, privateKey: device.privateKey } })
    .then((r) => r.content);

const sendEncrypted = (device, conversationId, encrypted, extra = {}) =>
  request.post(`/api/conversations/${conversationId}/messages`).set(auth(device.user.token)).set('X-Device-Id', String(device.id)).send({ encrypted, ...extra });

let aliceLaptop;
let bobPhone;

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  ({ config } = await import('../src/config/index.js'));
  alice = await registerUser(request, { name: 'Alice Secret' });
  bob = await registerUser(request, { name: 'Bob Secret' });
  carol = await registerUser(request, { name: 'Carol Outside' });
  chat = await connectUsers(request, alice, bob);
});

after(async () => {
  await server.close();
  await closeAll();
});

describe('device keys', () => {
  test('register, idempotent per key, validated, listed and limited', async () => {
    aliceLaptop = await newDevice(alice, 'Chrome on Windows');
    bobPhone = await newDevice(bob, 'Safari on iPhone');
    // The same browser signing in again keeps its device.
    const again = await request.post('/api/e2ee/devices').set(auth(alice.token)).send({ publicKey: aliceLaptop.publicKey, name: 'Chrome on Windows' }).expect(201);
    assert.equal(again.body.device.id, aliceLaptop.id);

    // Not a real P-256 point / wrong encoding → refused.
    const bogus = Buffer.alloc(65, 1);
    bogus[0] = 4;
    await request.post('/api/e2ee/devices').set(auth(alice.token)).send({ publicKey: bogus.toString('base64') }).expect(400);
    await request.post('/api/e2ee/devices').set(auth(alice.token)).send({ publicKey: 'not-a-key' }).expect(422);

    const mine = (await request.get('/api/e2ee/devices').set(auth(alice.token)).set('X-Device-Id', String(aliceLaptop.id)).expect(200)).body.devices;
    assert.deepEqual(mine.map((d) => [d.name, d.current]), [['Chrome on Windows', true]]);

    const devices = await devicesOf(alice, chat.id);
    assert.deepEqual(devices.map((d) => d.id).sort(), [aliceLaptop.id, bobPhone.id].sort());
    await request.get(`/api/e2ee/conversations/${chat.id}/devices`).set(auth(carol.token)).expect(404);
    // Device keys only for people I share a chat with.
    await request.get(`/api/e2ee/users/${bob.user.id}/devices`).set(auth(carol.token)).expect(404);
    assert.equal((await request.get(`/api/e2ee/users/${bob.user.id}/devices`).set(auth(alice.token)).expect(200)).body.devices.length, 1);
  });
});

describe('encrypted messages', () => {
  test('the server stores only ciphertext; each device gets its own key', async () => {
    const encrypted = await encryptFor(aliceLaptop, chat.id, { t: 'meet at 6 🕕' });
    const sent = (await sendEncrypted(aliceLaptop, chat.id, encrypted).expect(201)).body.message;
    assert.equal(sent.body, '');
    assert.equal(Object.keys(sent.e2ee.keys).length, 2);

    // Nothing readable in the database.
    const [[row]] = await pool.query('SELECT body, ciphertext, encrypted FROM messages WHERE id = ?', [sent.id]);
    assert.equal(row.body, '');
    assert.equal(row.encrypted, 1);
    assert.ok(!row.ciphertext.includes('meet'));

    // Bob's phone gets only its own key, and can read it; so can Alice's laptop.
    const history = (await request.get(`/api/conversations/${chat.id}/messages`).set(auth(bob.token)).set('X-Device-Id', String(bobPhone.id)).expect(200)).body.messages;
    const forBob = history.find((m) => m.id === sent.id);
    assert.deepEqual(Object.keys(forBob.e2ee.keys), [String(bobPhone.id)]);
    assert.equal((await read(forBob, bobPhone)).t, 'meet at 6 🕕');
    assert.equal((await read(sent, aliceLaptop)).t, 'meet at 6 🕕');

    // The chat list's last message is decryptable too.
    const conversation = (await request.get(`/api/conversations/${chat.id}`).set(auth(bob.token)).set('X-Device-Id', String(bobPhone.id)).expect(200)).body.conversation;
    assert.equal((await read(conversation.lastMessage, bobPhone)).t, 'meet at 6 🕕');
    // Someone else's device id in the header is ignored (no keys).
    const spoof = (await request.get(`/api/conversations/${chat.id}/messages`).set(auth(bob.token)).set('X-Device-Id', String(aliceLaptop.id)).expect(200)).body.messages;
    assert.deepEqual(spoof.find((m) => m.id === sent.id).e2ee.keys, {});
  });

  test('live: every device in the chat gets the message with its key', async () => {
    const bobSocket = await server.connect(bob.token, { auth: { token: bob.token, deviceId: bobPhone.id } });
    const aliceSocket = await server.connect(alice.token, { auth: { token: alice.token, deviceId: aliceLaptop.id } });
    const arrived = waitFor(bobSocket, 'message:new');
    const encrypted = await encryptFor(aliceLaptop, chat.id, { t: 'over the socket' });
    const ack = await emitAck(aliceSocket, 'message:send', { conversationId: chat.id, encrypted, clientId: 'e2ee-client-0001' });
    assert.equal(ack.ok, true, JSON.stringify(ack.error));
    assert.equal((await read(await arrived, bobPhone)).t, 'over the socket');
    bobSocket.disconnect();
    aliceSocket.disconnect();
  });

  test('a message must be encrypted for exactly the current devices', async () => {
    // Bob adds a tablet: Alice's old device list is now out of date.
    const bobTablet = await newDevice(bob, 'Firefox on tablet');
    const stale = await encryptFor(aliceLaptop, chat.id, { t: 'stale' }, [
      { id: aliceLaptop.id, publicKey: aliceLaptop.publicKey },
      { id: bobPhone.id, publicKey: bobPhone.publicKey },
    ]);
    const res = await sendEncrypted(aliceLaptop, chat.id, stale).expect(409);
    assert.equal(res.body.error.code, 'DEVICES_CHANGED');
    assert.equal(res.body.error.details.devices.length, 3);

    // A device that isn't in the chat can't be slipped in.
    const carolDevice = await newDevice(carol);
    const extra = await encryptFor(aliceLaptop, chat.id, { t: 'x' }, [...(await devicesOf(alice, chat.id)), { id: carolDevice.id, publicKey: carolDevice.publicKey }]);
    await sendEncrypted(aliceLaptop, chat.id, extra).expect(409);

    // Sending "from" someone else's device is refused.
    const forged = await encryptFor(aliceLaptop, chat.id, { t: 'x' });
    await sendEncrypted(aliceLaptop, chat.id, { ...forged, senderDeviceId: bobPhone.id }).expect(403);

    // With the fresh list everyone can read it — including the new tablet.
    const fresh = await encryptFor(aliceLaptop, chat.id, { t: 'hello tablet' });
    const sent = (await sendEncrypted(aliceLaptop, chat.id, fresh).expect(201)).body.message;
    assert.equal((await read(sent, bobTablet)).t, 'hello tablet');

    // Alice's chat with Bob says Bob's security code changed.
    const [[note]] = await pool.query("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND event_type = 'security_code_changed'", [chat.id]);
    assert.equal(note.n, 1);

    // Removing a device: no longer encrypted for.
    await request.delete(`/api/e2ee/devices/${bobTablet.id}`).set(auth(bob.token)).expect(204);
    assert.equal((await devicesOf(alice, chat.id)).length, 2);
    const reRegister = await request.post('/api/e2ee/devices').set(auth(bob.token)).send({ publicKey: bobTablet.publicKey }).expect(410);
    assert.equal(reRegister.body.error.code, 'DEVICE_REVOKED');
  });

  test('plain fields can\'t ride along, and "encryption required" refuses plaintext', async () => {
    const encrypted = await encryptFor(aliceLaptop, chat.id, { t: 'x' });
    await sendEncrypted(aliceLaptop, chat.id, encrypted, { body: 'leak' }).expect(400);
    config.e2ee.required = true;
    try {
      const res = await request.post(`/api/conversations/${chat.id}/messages`).set(auth(alice.token)).send({ body: 'plain' }).expect(400);
      assert.equal(res.body.error.code, 'ENCRYPTION_REQUIRED');
      await sendEncrypted(aliceLaptop, chat.id, await encryptFor(aliceLaptop, chat.id, { t: 'fine' })).expect(201);
    } finally {
      config.e2ee.required = false;
    }
  });

  test('edit, forward and delete-for-everyone', async () => {
    const typo = await encryptFor(aliceLaptop, chat.id, { t: 'typo' });
    const sent = (await sendEncrypted(aliceLaptop, chat.id, typo).expect(201)).body.message;
    // Editing needs a new ciphertext; plaintext edits are refused.
    await request.patch(`/api/messages/${sent.id}`).set(auth(alice.token)).send({ body: 'fixed' }).expect(400);
    const fixedText = await encryptFor(aliceLaptop, chat.id, { t: 'fixed' });
    const edited = (await request.patch(`/api/messages/${sent.id}`).set(auth(alice.token)).send({ encrypted: fixedText }).expect(200)).body.message;
    assert.ok(edited.editedAt);
    assert.equal((await read(edited, aliceLaptop)).t, 'fixed');

    // Forwarding: the server can't copy encrypted text, so the device re-encrypts (forwardFrom).
    await request.post(`/api/messages/${sent.id}/forward`).set(auth(alice.token)).send({ conversationIds: [chat.id] }).expect(400);
    const copy = await encryptFor(aliceLaptop, chat.id, { t: 'fixed' });
    const forwarded = (await sendEncrypted(aliceLaptop, chat.id, copy, { forwardFrom: sent.id }).expect(201)).body.message;
    assert.equal(forwarded.forwarded, true);
    const other = await encryptFor(aliceLaptop, chat.id, { t: 'x' });
    await sendEncrypted(aliceLaptop, chat.id, other, { forwardFrom: 999999 }).expect(404);

    await request.delete(`/api/messages/${sent.id}?scope=everyone`).set(auth(alice.token)).expect(200);
    const [[row]] = await pool.query('SELECT ciphertext, (SELECT COUNT(*) FROM message_keys WHERE message_id = ?) AS keys_left FROM messages WHERE id = ?', [sent.id, sent.id]);
    assert.equal(row.ciphertext, null);
    assert.equal(row.keys_left, 0);
  });

  test('encrypted files are opaque to the server; their key travels in the message', async () => {
    const secret = new TextEncoder().encode('MZ pretend this is anything');
    const sealed = await e2ee.encryptBytes(secret);
    const upload = await request
      .post('/api/attachments')
      .set(auth(alice.token))
      .field('conversationId', String(chat.id))
      .field('kind', 'file')
      .field('encrypted', 'true')
      .attach('file', Buffer.from(sealed.ciphertext), 'whatever.bin')
      .expect(201);
    const attachment = upload.body.attachment;
    assert.equal(attachment.encrypted, true);
    assert.equal(attachment.mimeType, 'application/octet-stream');
    assert.equal(attachment.name, 'encrypted');

    const content = { t: '', at: [{ id: attachment.id, key: sealed.key, iv: sealed.iv, name: 'plan.pdf', mime: 'application/pdf' }] };
    const sent = (await sendEncrypted(aliceLaptop, chat.id, await encryptFor(aliceLaptop, chat.id, content), { attachmentIds: [attachment.id] }).expect(201)).body.message;
    const meta = (await read(sent, bobPhone)).at[0];
    const download = await request.get(sent.attachments[0].url).set(auth(bob.token)).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    assert.equal(download.headers['content-type'], 'application/octet-stream');
    const plain = new TextDecoder().decode(await e2ee.decryptBytes(download.body, meta.key, meta.iv));
    assert.equal(plain, 'MZ pretend this is anything');

    // Server search skips encrypted messages (it can't read them; their files are all named "encrypted").
    const older = (await request.post(`/api/conversations/${chat.id}/messages`).set(auth(alice.token)).send({ body: 'an older encrypted-word note' }).expect(201)).body.message;
    for (const query of ['encrypted', 'encrypted-word']) {
      const found = (await request.get(`/api/messages/search?q=${query}&conversationId=${chat.id}`).set(auth(bob.token)).expect(200)).body.messages;
      assert.deepEqual(found.map((m) => m.id), [older.id], `search "${query}"`);
    }

    // An encrypted image (e.g. a GIF) can be sent again: the file is shared, the key goes in the new message.
    const gifSealed = await e2ee.encryptBytes(new TextEncoder().encode('GIF89a...'));
    const gif = (
      await request.post('/api/attachments').set(auth(alice.token)).field('conversationId', String(chat.id)).field('kind', 'image').field('encrypted', 'true')
        .attach('file', Buffer.from(gifSealed.ciphertext), 'x').expect(201)
    ).body.attachment;
    const gifContent = { t: '', at: [{ id: gif.id, key: gifSealed.key, iv: gifSealed.iv, mime: 'image/gif' }] };
    await sendEncrypted(aliceLaptop, chat.id, await encryptFor(aliceLaptop, chat.id, gifContent), { attachmentIds: [gif.id] }).expect(201);
    const again = (await request.post('/api/gifs/reuse').set(auth(bob.token)).send({ conversationId: chat.id, attachmentId: gif.id }).expect(201)).body.attachment;
    assert.equal(again.encrypted, true);
    // …but not an encrypted document.
    await request.post('/api/gifs/reuse').set(auth(bob.token)).send({ conversationId: chat.id, attachmentId: attachment.id }).expect(404);

    // Size limits still apply; kinds must be declared.
    await request.post('/api/attachments').set(auth(alice.token)).field('conversationId', String(chat.id)).field('encrypted', 'true').attach('file', Buffer.alloc(100), 'x').expect(400);
  });

  test('mentions are declared for notifications; batch lookup is participant-only', async () => {
    const group = (await request.post('/api/groups').set(auth(alice.token)).send({ name: 'Secret club', memberIds: [bob.user.id] }).expect(201)).body.conversation;
    const sent = (
      await sendEncrypted(aliceLaptop, group.id, await encryptFor(aliceLaptop, group.id, { t: '@Bob look' }), { mentions: [bob.user.id, carol.user.id] }).expect(201)
    ).body.message;
    await new Promise((r) => setTimeout(r, 200));
    const notes = (await request.get('/api/notifications').set(auth(bob.token)).expect(200)).body.notifications;
    const mention = notes.find((n) => n.type === 'mention' && n.messageId === sent.id);
    assert.ok(mention, 'Bob got a mention notification');
    assert.equal(mention.preview ?? '', '');
    // Carol isn't in the group: her "mention" is dropped.
    assert.equal((await request.get('/api/notifications').set(auth(carol.token)).expect(200)).body.notifications.length, 0);

    const batch = (await request.get(`/api/messages/batch?ids=${sent.id}`).set(auth(bob.token)).set('X-Device-Id', String(bobPhone.id)).expect(200)).body.messages;
    assert.equal((await read(batch[0], bobPhone)).t, '@Bob look');
    assert.equal((await request.get(`/api/messages/batch?ids=${sent.id}`).set(auth(carol.token)).expect(200)).body.messages.length, 0);
  });

  test('encrypted live location: positions stay ciphertext', async () => {
    const { encrypted, messageKey } = await e2ee.encryptContent({
      content: { t: '', liveLocation: true },
      conversationId: chat.id,
      me: { userId: alice.user.id, deviceId: aliceLaptop.id, privateKey: aliceLaptop.privateKey },
      devices: await devicesOf(alice, chat.id),
    });
    const first = await e2ee.sealWithMessageKey(messageKey, 0, { lat: 1, lng: 2 });
    const sent = (await sendEncrypted(aliceLaptop, chat.id, encrypted, { encryptedLocation: { ...first, liveMinutes: 15 } }).expect(201)).body.message;
    assert.equal(sent.location.encrypted.cipher, first.ciphertext);
    assert.equal(sent.location.latitude, null);
    const socket = await server.connect(alice.token);
    const moved = await e2ee.sealWithMessageKey(messageKey, sent.id, { lat: 3, lng: 4 });
    const res = await emitAck(socket, 'location:update', { messageId: sent.id, ...moved });
    assert.equal(res.ok, true, JSON.stringify(res.error));
    const [[row]] = await pool.query('SELECT latitude, cipher FROM message_locations WHERE message_id = ?', [sent.id]);
    assert.equal(row.latitude, null);
    assert.deepEqual(await e2ee.openWithMessageKey(messageKey, sent.id, { ciphertext: row.cipher, iv: res.data.location.encrypted.iv }), { lat: 3, lng: 4 });
    socket.disconnect();
  });
});
