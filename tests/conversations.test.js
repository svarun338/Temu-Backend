import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auth, closeAll, connectUsers, pool, registerUser, resetDatabase, startServer } from './helpers.js';

let server;
let request;
let alice;
let bob;
let eve;
let conversation;

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice' });
  bob = await registerUser(request, { name: 'Bob' });
  eve = await registerUser(request, { name: 'Eve' });
});

after(async () => {
  await server.close();
  await closeAll();
});

const send = (user, conversationId, body, extra = {}) =>
  request.post(`/api/conversations/${conversationId}/messages`).set(auth(user.token)).send({ body, ...extra });

describe('opening conversations', () => {
  test('requires the other user to be a contact', async () => {
    const res = await request.post('/api/conversations').set(auth(alice.token)).send({ userId: bob.user.id }).expect(403);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  });

  test('creates one conversation per pair and reuses it', async () => {
    conversation = await connectUsers(request, alice, bob);
    assert.equal(conversation.peer.id, bob.user.id);
    assert.equal(conversation.unreadCount, 0);
    assert.equal(conversation.lastMessage, null);

    const again = await request.post('/api/conversations').set(auth(alice.token)).send({ userId: bob.user.id }).expect(200);
    assert.equal(again.body.conversation.id, conversation.id);
    const fromBob = await request.post('/api/conversations').set(auth(bob.token)).send({ userId: alice.user.id }).expect(200);
    assert.equal(fromBob.body.conversation.id, conversation.id);
    assert.equal(fromBob.body.conversation.peer.id, alice.user.id);

    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM conversations');
    assert.equal(rows[0].n, 1);
  });

  test('cannot open a conversation with yourself', async () => {
    await request.post('/api/conversations').set(auth(alice.token)).send({ userId: alice.user.id }).expect(400);
  });
});

describe('messages', () => {
  test('are stored in SQL and attributed to the authenticated sender only', async () => {
    const res = await send(alice, conversation.id, '  Hello Bob!  ', { senderId: bob.user.id }).expect(201);
    assert.equal(res.body.message.senderId, alice.user.id);
    assert.equal(res.body.message.body, 'Hello Bob!');
    assert.equal(res.body.message.status, 'sent');

    const [rows] = await pool.query('SELECT sender_id, body FROM messages WHERE id = ?', [res.body.message.id]);
    assert.deepEqual(rows[0], { sender_id: alice.user.id, body: 'Hello Bob!' });
  });

  test('store HTML as inert text (rendered escaped by the client)', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const res = await send(bob, conversation.id, payload).expect(201);
    assert.equal(res.body.message.body, payload);
  });

  test('are validated', async () => {
    await send(alice, conversation.id, '   ').expect(422);
    await send(alice, conversation.id, 'x'.repeat(4001)).expect(422);
    await send(alice, conversation.id, 'ok', { clientId: 'bad id!' }).expect(422);
  });

  test('sending is idempotent per clientId', async () => {
    const first = await send(alice, conversation.id, 'retry me', { clientId: 'client-abc-123' }).expect(201);
    const second = await send(alice, conversation.id, 'retry me', { clientId: 'client-abc-123' }).expect(200);
    assert.equal(first.body.message.id, second.body.message.id);
  });

  test('history is paginated oldest → newest', async () => {
    for (let i = 1; i <= 5; i += 1) await send(alice, conversation.id, `page ${i}`).expect(201);
    const latest = await request.get(`/api/conversations/${conversation.id}/messages?limit=3`).set(auth(bob.token)).expect(200);
    assert.deepEqual(latest.body.messages.map((m) => m.body), ['page 3', 'page 4', 'page 5']);
    assert.equal(latest.body.hasMore, true);

    const older = await request
      .get(`/api/conversations/${conversation.id}/messages?limit=3&before=${latest.body.messages[0].id}`)
      .set(auth(bob.token))
      .expect(200);
    assert.deepEqual(older.body.messages.map((m) => m.body), ['retry me', 'page 1', 'page 2']);

    const newer = await request
      .get(`/api/conversations/${conversation.id}/messages?after=${older.body.messages[2].id}`)
      .set(auth(bob.token))
      .expect(200);
    assert.deepEqual(newer.body.messages.map((m) => m.body), ['page 3', 'page 4', 'page 5']);
  });

  test('unread counts and the latest message appear in the conversation list', async () => {
    const res = await request.get('/api/conversations').set(auth(bob.token)).expect(200);
    const item = res.body.conversations.find((c) => c.id === conversation.id);
    assert.equal(item.lastMessage.body, 'page 5');
    assert.equal(item.unreadCount, 7); // "Hello Bob!", "retry me" and "page 1".."page 5" from Alice
  });

  test('marking as read clears unread count and sets read status', async () => {
    const res = await request.post(`/api/conversations/${conversation.id}/read`).set(auth(bob.token)).send({}).expect(200);
    assert.equal(res.body.receipt.status, 'read');

    const list = await request.get('/api/conversations').set(auth(bob.token)).expect(200);
    assert.equal(list.body.conversations.find((c) => c.id === conversation.id).unreadCount, 0);

    const history = await request.get(`/api/conversations/${conversation.id}/messages`).set(auth(alice.token)).expect(200);
    for (const message of history.body.messages.filter((m) => m.senderId === alice.user.id)) {
      assert.equal(message.status, 'read');
      assert.ok(message.deliveredAt);
    }
    // Bob's own message is still unread by Alice.
    const bobsMessage = history.body.messages.find((m) => m.senderId === bob.user.id);
    assert.equal(bobsMessage.status, 'sent');
  });
});

describe('authorization', () => {
  test('outsiders cannot read, write or mark someone else’s conversation', async () => {
    await request.get(`/api/conversations/${conversation.id}`).set(auth(eve.token)).expect(404);
    await request.get(`/api/conversations/${conversation.id}/messages`).set(auth(eve.token)).expect(404);
    await send(eve, conversation.id, 'let me in').expect(404);
    await request.post(`/api/conversations/${conversation.id}/read`).set(auth(eve.token)).send({}).expect(404);

    const list = await request.get('/api/conversations').set(auth(eve.token)).expect(200);
    assert.equal(list.body.conversations.length, 0);
  });

  test('a clientId reused in another conversation is rejected', async () => {
    await request.post('/api/contacts').set(auth(alice.token)).send({ userId: eve.user.id }).expect(201);
    const other = await request.post('/api/conversations').set(auth(alice.token)).send({ userId: eve.user.id }).expect(201);
    await send(alice, other.body.conversation.id, 'retry me', { clientId: 'client-abc-123' }).expect(409);
  });

  test('empty conversations are hidden from the recipient until a message arrives', async () => {
    const list = await request.get('/api/conversations').set(auth(eve.token)).expect(200);
    assert.equal(list.body.conversations.length, 0);
  });

  test('invalid ids are rejected', async () => {
    await request.get('/api/conversations/abc/messages').set(auth(alice.token)).expect(422);
    await request.get('/api/conversations/-1').set(auth(alice.token)).expect(422);
    await request.get(`/api/conversations/${conversation.id}/messages?before=1&after=2`).set(auth(alice.token)).expect(422);
  });
});
