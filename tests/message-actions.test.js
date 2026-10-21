import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auth, closeAll, connectUsers, emitAck, pool, registerUser, resetDatabase, startServer, waitFor } from './helpers.js';

let server;
let request;
let alice;
let bob;
let carol; // outsider to the Alice–Bob chat
let ab; // Alice–Bob conversation
let ac; // Alice–Carol conversation

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice Actions' });
  bob = await registerUser(request, { name: 'Bob Actions' });
  carol = await registerUser(request, { name: 'Carol Actions' });
  ab = await connectUsers(request, alice, bob);
  ac = await connectUsers(request, alice, carol);
});

after(async () => {
  await server.close();
  await closeAll();
});

async function send(user, conversation, body, extra = {}) {
  const res = await request
    .post(`/api/conversations/${conversation.id}/messages`)
    .set(auth(user.token))
    .send({ body, ...extra })
    .expect(201);
  return res.body.message;
}

const history = async (user, conversation) =>
  (await request.get(`/api/conversations/${conversation.id}/messages?limit=100`).set(auth(user.token)).expect(200)).body.messages;

/** Make a message look older than it is. */
const ageMessage = (id, minutes) =>
  pool.query('UPDATE messages SET created_at = created_at - INTERVAL ? MINUTE WHERE id = ?', [minutes, id]);

describe('reply', () => {
  test('a reply carries a preview of the quoted message', async () => {
    const original = await send(bob, ab, 'What time is the meeting?');
    const reply = await send(alice, ab, 'At 3pm', { replyToId: original.id });
    assert.deepEqual(reply.replyTo, { id: original.id, senderId: bob.user.id, senderName: 'Bob Actions', body: 'What time is the meeting?', sticker: null, encrypted: false, deleted: false, attachmentKind: null, locationKind: null });

    const listed = (await history(bob, ab)).find((m) => m.id === reply.id);
    assert.equal(listed.replyTo.body, 'What time is the meeting?');
  });

  test('replies over sockets work too', async () => {
    const original = await send(bob, ab, 'Socket question');
    const socket = await server.connect(alice.token);
    const ack = await emitAck(socket, 'message:send', { conversationId: ab.id, body: 'Socket answer', replyToId: original.id });
    assert.equal(ack.ok, true);
    assert.equal(ack.data.message.replyTo.id, original.id);
    socket.disconnect();
  });

  test('cannot quote a message from another conversation', async () => {
    const elsewhere = await send(carol, ac, 'Private to Alice and Carol');
    await request
      .post(`/api/conversations/${ab.id}/messages`)
      .set(auth(bob.token))
      .send({ body: 'quoting a secret', replyToId: elsewhere.id })
      .expect(400);
  });
});

describe('edit', () => {
  test('the sender can edit within the time limit; both sides get the update live', async () => {
    const message = await send(alice, ab, 'Helo');
    const bobSocket = await server.connect(bob.token);
    const updated = waitFor(bobSocket, 'message:updated', (m) => m.id === message.id);

    const res = await request.patch(`/api/messages/${message.id}`).set(auth(alice.token)).send({ body: 'Hello' }).expect(200);
    assert.equal(res.body.message.body, 'Hello');
    assert.ok(res.body.message.editedAt);
    assert.equal((await updated).body, 'Hello');
    bobSocket.disconnect();
  });

  test("nobody can edit someone else's message", async () => {
    const message = await send(alice, ab, 'Mine');
    await request.patch(`/api/messages/${message.id}`).set(auth(bob.token)).send({ body: 'Hacked' }).expect(403);
    await request.patch(`/api/messages/${message.id}`).set(auth(carol.token)).send({ body: 'Hacked' }).expect(404);
  });

  test('editing is closed after 15 minutes', async () => {
    const message = await send(alice, ab, 'Old news');
    await ageMessage(message.id, 16);
    await request.patch(`/api/messages/${message.id}`).set(auth(alice.token)).send({ body: 'New news' }).expect(403);
  });

  test('edits are validated like new messages', async () => {
    const message = await send(alice, ab, 'Valid');
    await request.patch(`/api/messages/${message.id}`).set(auth(alice.token)).send({ body: '   ' }).expect(422);
  });
});

describe('delete', () => {
  test('delete for everyone erases the content for both sides and updates quotes', async () => {
    const message = await send(alice, ab, 'Oops, wrong chat');
    const reply = await send(bob, ab, 'What?', { replyToId: message.id });
    const bobSocket = await server.connect(bob.token);
    const updated = waitFor(bobSocket, 'message:updated', (m) => m.id === message.id);

    const res = await request.delete(`/api/messages/${message.id}?scope=everyone`).set(auth(alice.token)).expect(200);
    assert.equal(res.body.message.body, '');
    assert.ok(res.body.message.deletedAt);
    assert.ok((await updated).deletedAt);

    const bobsView = await history(bob, ab);
    assert.equal(bobsView.find((m) => m.id === message.id).body, '');
    assert.equal(bobsView.find((m) => m.id === reply.id).replyTo.deleted, true);
    const [rows] = await pool.query('SELECT body FROM messages WHERE id = ?', [message.id]);
    assert.equal(rows[0].body, '', 'content is erased from the database');
    bobSocket.disconnect();
  });

  test("only the sender can delete for everyone, and only within 48 hours", async () => {
    const message = await send(alice, ab, 'Keep me');
    await request.delete(`/api/messages/${message.id}?scope=everyone`).set(auth(bob.token)).expect(403);
    await ageMessage(message.id, 49 * 60);
    await request.delete(`/api/messages/${message.id}?scope=everyone`).set(auth(alice.token)).expect(403);
  });

  test('delete for me hides it only for me, including the chat preview', async () => {
    const message = await send(bob, ab, 'Hide this for Alice');
    await request.delete(`/api/messages/${message.id}?scope=me`).set(auth(alice.token)).expect(200);

    assert.ok(!(await history(alice, ab)).some((m) => m.id === message.id));
    assert.ok((await history(bob, ab)).some((m) => m.id === message.id), 'Bob still sees it');

    const alicesList = (await request.get('/api/conversations').set(auth(alice.token)).expect(200)).body.conversations;
    assert.notEqual(alicesList.find((c) => c.id === ab.id).lastMessage.id, message.id);
  });

  test('requires a valid scope and access', async () => {
    const message = await send(alice, ab, 'Scoped');
    await request.delete(`/api/messages/${message.id}`).set(auth(alice.token)).expect(422);
    await request.delete(`/api/messages/${message.id}?scope=me`).set(auth(carol.token)).expect(404);
  });
});

describe('reactions', () => {
  test('add, replace and remove a reaction; both sides are updated live', async () => {
    const message = await send(bob, ab, 'React to me');
    const bobSocket = await server.connect(bob.token);

    let event = waitFor(bobSocket, 'message:reactions', (e) => e.messageId === message.id);
    await request.put(`/api/messages/${message.id}/reaction`).set(auth(alice.token)).send({ emoji: '👍' }).expect(200);
    assert.deepEqual((await event).reactions, [{ emoji: '👍', userId: alice.user.id }]);

    const replaced = await request.put(`/api/messages/${message.id}/reaction`).set(auth(alice.token)).send({ emoji: '❤️' }).expect(200);
    assert.deepEqual(replaced.body.reactions, [{ emoji: '❤️', userId: alice.user.id }], 'one reaction per person');

    event = waitFor(bobSocket, 'message:reactions', (e) => e.messageId === message.id && e.reactions.length === 0);
    await request.delete(`/api/messages/${message.id}/reaction`).set(auth(alice.token)).expect(200);
    await event;

    await request.put(`/api/messages/${message.id}/reaction`).set(auth(bob.token)).send({ emoji: '😂' }).expect(200);
    const listed = (await history(alice, ab)).find((m) => m.id === message.id);
    assert.deepEqual(listed.reactions, [{ emoji: '😂', userId: bob.user.id }]);
    bobSocket.disconnect();
  });

  test('only a single emoji is accepted, and outsiders cannot react', async () => {
    const message = await send(bob, ab, 'Strict');
    for (const emoji of ['ok', '👍👍', '<script>', '']) {
      await request.put(`/api/messages/${message.id}/reaction`).set(auth(alice.token)).send({ emoji }).expect(422);
    }
    await request.put(`/api/messages/${message.id}/reaction`).set(auth(carol.token)).send({ emoji: '👍' }).expect(404);
  });
});

describe('stars', () => {
  test('stars are private to the user and listed in "starred messages"', async () => {
    const message = await send(bob, ab, 'Remember this');
    await request.put(`/api/messages/${message.id}/star`).set(auth(alice.token)).expect(200);

    assert.equal((await history(alice, ab)).find((m) => m.id === message.id).starred, true);
    assert.equal((await history(bob, ab)).find((m) => m.id === message.id).starred, false, 'Bob does not see Alice’s star');

    const starred = (await request.get('/api/messages/starred').set(auth(alice.token)).expect(200)).body.messages;
    assert.equal(starred[0].id, message.id);
    assert.ok(starred[0].starredAt);

    await request.delete(`/api/messages/${message.id}/star`).set(auth(alice.token)).expect(200);
    assert.equal((await request.get('/api/messages/starred').set(auth(alice.token))).body.messages.length, 0);
    await request.put(`/api/messages/${message.id}/star`).set(auth(carol.token)).expect(404);
  });
});

describe('pins', () => {
  test('pins are shared, broadcast, and limited to 3 (oldest replaced)', async () => {
    const ids = [];
    for (let i = 1; i <= 4; i += 1) ids.push((await send(alice, ab, `Pin me ${i}`)).id);
    const bobSocket = await server.connect(bob.token);

    for (const id of ids.slice(0, 3)) await request.put(`/api/messages/${id}/pin`).set(auth(alice.token)).expect(200);
    const event = waitFor(bobSocket, 'conversation:pins', (e) => e.pins.some((p) => p.messageId === ids[3]));
    const res = await request.put(`/api/messages/${ids[3]}/pin`).set(auth(bob.token)).expect(200);
    assert.deepEqual(res.body.pins.map((p) => p.messageId), [ids[3], ids[2], ids[1]]);
    await event;

    const listed = (await request.get(`/api/conversations/${ab.id}/pins`).set(auth(bob.token)).expect(200)).body.pins;
    assert.equal(listed.length, 3);
    await request.get(`/api/conversations/${ab.id}/pins`).set(auth(carol.token)).expect(404);

    await request.delete(`/api/messages/${ids[3]}/pin`).set(auth(alice.token)).expect(200);
    assert.equal((await request.get(`/api/conversations/${ab.id}/pins`).set(auth(alice.token))).body.pins.length, 2);
    bobSocket.disconnect();
  });

  test('deleting a pinned message for everyone unpins it', async () => {
    const message = await send(alice, ab, 'Pinned then deleted');
    await request.put(`/api/messages/${message.id}/pin`).set(auth(alice.token)).expect(200);
    await request.delete(`/api/messages/${message.id}?scope=everyone`).set(auth(alice.token)).expect(200);
    const pins = (await request.get(`/api/conversations/${ab.id}/pins`).set(auth(alice.token))).body.pins;
    assert.ok(!pins.some((p) => p.messageId === message.id));
    await request.put(`/api/messages/${message.id}/pin`).set(auth(alice.token)).expect(400);
  });
});

describe('forward', () => {
  test('forwards into other chats as a new "forwarded" message', async () => {
    const message = await send(bob, ab, 'Pass this on');
    const carolSocket = await server.connect(carol.token);
    const received = waitFor(carolSocket, 'message:new', (m) => m.body === 'Pass this on');

    const res = await request.post(`/api/messages/${message.id}/forward`).set(auth(alice.token)).send({ conversationIds: [ac.id] }).expect(201);
    assert.equal(res.body.messages[0].forwarded, true);
    assert.equal(res.body.messages[0].senderId, alice.user.id);
    assert.equal((await received).forwarded, true);
    carolSocket.disconnect();
  });

  test('cannot forward into chats you are not part of, or deleted messages', async () => {
    const message = await send(bob, ab, 'Mine to share');
    // Bob is not in the Alice–Carol chat.
    await request.post(`/api/messages/${message.id}/forward`).set(auth(bob.token)).send({ conversationIds: [ac.id] }).expect(404);
    // Carol cannot see the source message.
    await request.post(`/api/messages/${message.id}/forward`).set(auth(carol.token)).send({ conversationIds: [ac.id] }).expect(404);

    const gone = await send(alice, ab, 'Soon deleted');
    await request.delete(`/api/messages/${gone.id}?scope=everyone`).set(auth(alice.token)).expect(200);
    await request.post(`/api/messages/${gone.id}/forward`).set(auth(alice.token)).send({ conversationIds: [ac.id] }).expect(400);
    await request.post(`/api/messages/${message.id}/forward`).set(auth(alice.token)).send({ conversationIds: [] }).expect(422);
  });
});

describe('search', () => {
  test('finds only my visible messages, optionally in one chat', async () => {
    await send(bob, ab, 'The secret word is pineapple');
    await send(carol, ac, 'pineapple pizza?');
    const hidden = await send(bob, ab, 'pineapple hidden for alice');
    await request.delete(`/api/messages/${hidden.id}?scope=me`).set(auth(alice.token)).expect(200);

    const all = (await request.get('/api/messages/search?q=pineapple').set(auth(alice.token)).expect(200)).body.messages;
    assert.deepEqual(all.map((m) => m.body).sort(), ['The secret word is pineapple', 'pineapple pizza?'].sort());

    const inChat = (await request.get(`/api/messages/search?q=pineapple&conversationId=${ab.id}`).set(auth(alice.token))).body.messages;
    assert.equal(inChat.length, 1);

    const bobs = (await request.get('/api/messages/search?q=pineapple').set(auth(bob.token))).body.messages;
    assert.ok(!bobs.some((m) => m.body === 'pineapple pizza?'), "Bob cannot find messages from chats he isn't in");

    await request.get(`/api/messages/search?q=pineapple&conversationId=${ac.id}`).set(auth(bob.token)).expect(404);
    const wildcard = (await request.get('/api/messages/search?q=%25%25').set(auth(alice.token))).body.messages;
    assert.equal(wildcard.length, 0, 'LIKE wildcards are matched literally');
  });
});
