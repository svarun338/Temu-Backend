import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auth,
  closeAll,
  connectUsers,
  emitAck,
  expectNoEvent,
  pool,
  registerUser,
  resetDatabase,
  startServer,
  waitFor,
} from './helpers.js';

let server;
let request;
let alice;
let bob;
let eve;
let conversation;
let open = [];

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice' });
  bob = await registerUser(request, { name: 'Bob' });
  eve = await registerUser(request, { name: 'Eve' });
  conversation = await connectUsers(request, alice, bob);
});

beforeEach(() => {
  for (const socket of open) socket.disconnect();
  open = [];
});

after(async () => {
  await server.close();
  await closeAll();
});

async function connect(user) {
  const socket = await server.connect(user.token);
  open.push(socket);
  return socket;
}

describe('socket authentication', () => {
  test('rejects connections without a valid token', async () => {
    for (const token of [undefined, 'garbage']) {
      await assert.rejects(server.connect(token), (error) => {
        assert.equal(error.message, 'UNAUTHORIZED');
        return true;
      });
    }
  });

  test('rejects tokens of a logged-out session and disconnects live sockets on logout', async () => {
    const login = await request.post('/api/auth/login').send({ email: eve.user.email, password: eve.password }).expect(200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const socket = await connect({ token: login.body.accessToken });

    const disconnected = waitFor(socket, 'disconnect');
    await request.post('/api/auth/logout').set('X-Requested-With', 'XMLHttpRequest').set('Cookie', cookie).expect(204);
    assert.equal(await disconnected, 'io server disconnect');
    await assert.rejects(server.connect(login.body.accessToken));
  });
});

describe('real-time messaging', () => {
  test('a message is persisted before the ack and delivered instantly to the recipient', async () => {
    const a = await connect(alice);
    const b = await connect(bob);

    const incoming = waitFor(b, 'message:new');
    const ack = await emitAck(a, 'message:send', {
      conversationId: conversation.id,
      body: 'Hi Bob 👋',
      clientId: 'sock-msg-0001',
      senderId: bob.user.id, // must be ignored
    });
    assert.equal(ack.ok, true);
    assert.equal(ack.data.message.senderId, alice.user.id);

    const [rows] = await pool.query('SELECT body, sender_id FROM messages WHERE id = ?', [ack.data.message.id]);
    assert.deepEqual(rows[0], { body: 'Hi Bob 👋', sender_id: alice.user.id });

    const received = await incoming;
    assert.equal(received.id, ack.data.message.id);
    assert.equal(received.clientId, 'sock-msg-0001');
  });

  test('delivered and read receipts reach the sender', async () => {
    const a = await connect(alice);
    const b = await connect(bob);

    const incoming = waitFor(b, 'message:new');
    const { data } = await emitAck(a, 'message:send', { conversationId: conversation.id, body: 'receipts?' });
    await incoming;

    const delivered = waitFor(a, 'message:status', (r) => r.status === 'delivered');
    await emitAck(b, 'message:delivered', { conversationId: conversation.id, messageId: data.message.id });
    const deliveredReceipt = await delivered;
    assert.equal(deliveredReceipt.upToMessageId, data.message.id);
    assert.equal(deliveredReceipt.byUserId, bob.user.id);

    const read = waitFor(a, 'message:status', (r) => r.status === 'read');
    await emitAck(b, 'message:read', { conversationId: conversation.id });
    assert.equal((await read).upToMessageId, data.message.id);

    const [rows] = await pool.query('SELECT delivered_at, read_at FROM messages WHERE id = ?', [data.message.id]);
    assert.ok(rows[0].delivered_at && rows[0].read_at);
  });

  test('messages sent while the recipient is offline are marked delivered when they connect', async () => {
    const a = await connect(alice);
    const { data } = await emitAck(a, 'message:send', { conversationId: conversation.id, body: 'while you were away' });
    assert.equal(data.message.status, 'sent');

    const delivered = waitFor(a, 'message:status', (r) => r.status === 'delivered' && r.upToMessageId >= data.message.id);
    await connect(bob);
    await delivered;
  });

  test('the first message of a brand-new conversation reaches the recipient', async () => {
    await request.post('/api/contacts').set(auth(eve.token)).send({ userId: bob.user.id }).expect(201);
    const b = await connect(bob);
    const freshEve = (await request.post('/api/auth/login').send({ email: eve.user.email, password: eve.password })).body;
    const e = await connect({ token: freshEve.accessToken });

    const res = await request.post('/api/conversations').set(auth(freshEve.accessToken)).send({ userId: bob.user.id }).expect(201);
    const incoming = waitFor(b, 'message:new', (m) => m.conversationId === res.body.conversation.id);
    const ack = await emitAck(e, 'message:send', { conversationId: res.body.conversation.id, body: 'Hi, I am new here' });
    assert.equal(ack.ok, true);
    assert.equal((await incoming).body, 'Hi, I am new here');
  });

  test('REST sends are broadcast over sockets too', async () => {
    const b = await connect(bob);
    const incoming = waitFor(b, 'message:new', (m) => m.body === 'via REST');
    await request.post(`/api/conversations/${conversation.id}/messages`).set(auth(alice.token)).send({ body: 'via REST' }).expect(201);
    await incoming;
  });

  test('invalid payloads get an error ack', async () => {
    const a = await connect(alice);
    const ack = await emitAck(a, 'message:send', { conversationId: conversation.id, body: '' });
    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, 'VALIDATION_ERROR');
  });

  test('both people sending at the same moment never deadlock', async () => {
    const senders = await Promise.all([alice, alice, alice, bob, bob, bob].map(connect));
    const acks = await Promise.all(
      senders.flatMap((socket) =>
        Array.from({ length: 15 }, (_, i) => emitAck(socket, 'message:send', { conversationId: conversation.id, body: `burst ${i}` })),
      ),
    );
    assert.deepEqual(acks.filter((ack) => !ack.ok).map((ack) => ack.error), []);

    const ids = acks.map((ack) => ack.data.message.id);
    const [[row]] = await pool.query('SELECT last_message_id FROM conversations WHERE id = ?', [conversation.id]);
    assert.equal(row.last_message_id, Math.max(...ids));
  });

  test('delivered and read receipts arriving together with new messages never deadlock', async () => {
    const [a1, a2, b1, b2] = await Promise.all([alice, alice, bob, bob].map(connect));
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) => [
        emitAck(a1, 'message:send', { conversationId: conversation.id, body: `ping ${i}` }),
        emitAck(a2, 'message:send', { conversationId: conversation.id, body: `pong ${i}` }),
        emitAck(b1, 'message:delivered', { conversationId: conversation.id }),
        emitAck(b2, 'message:read', { conversationId: conversation.id }),
        emitAck(b1, 'message:read', { conversationId: conversation.id }),
        emitAck(b2, 'message:delivered', { conversationId: conversation.id }),
      ]).flat(),
    );
    assert.deepEqual(results.filter((ack) => !ack.ok).map((ack) => ack.error), []);
  });
});

describe('typing indicators', () => {
  test('are relayed to the other participant only', async () => {
    const a = await connect(alice);
    const b = await connect(bob);

    const typing = waitFor(b, 'typing', (t) => t.isTyping);
    const ack = await emitAck(a, 'typing:start', { conversationId: conversation.id });
    assert.equal(ack.ok, true);
    assert.deepEqual(await typing, { conversationId: conversation.id, userId: alice.user.id, isTyping: true, activity: 'typing' });

    // Recording a voice message is relayed as a different activity.
    const recording = waitFor(b, 'typing', (t) => t.activity === 'recording');
    await emitAck(a, 'typing:start', { conversationId: conversation.id, activity: 'recording' });
    assert.equal((await recording).isTyping, true);

    const stopped = waitFor(b, 'typing', (t) => !t.isTyping);
    await emitAck(a, 'typing:stop', { conversationId: conversation.id });
    await stopped;
  });

  test('stop automatically when the typist disconnects', async () => {
    const a = await connect(alice);
    const b = await connect(bob);
    const started = waitFor(b, 'typing', (t) => t.isTyping);
    await emitAck(a, 'typing:start', { conversationId: conversation.id });
    await started;
    const stopped = waitFor(b, 'typing', (t) => !t.isTyping);
    a.disconnect();
    await stopped;
  });
});

describe('presence', () => {
  test('online and offline updates are sent to contacts', async () => {
    const a = await connect(alice);
    const online = waitFor(a, 'presence:update', (p) => p.userId === bob.user.id && p.isOnline);
    const b = await connect(bob);
    await online;

    const contacts = await request.get('/api/contacts').set(auth(alice.token)).expect(200);
    assert.equal(contacts.body.contacts.find((c) => c.id === bob.user.id).isOnline, true);

    const offline = waitFor(a, 'presence:update', (p) => p.userId === bob.user.id && !p.isOnline);
    b.disconnect();
    const update = await offline;
    assert.ok(update.lastSeenAt);
  });

  test('a user stays online while another tab is still connected', async () => {
    const a = await connect(alice);
    await connect(bob);
    const b2 = await connect(bob);
    const noOffline = expectNoEvent(a, 'presence:update', 400);
    b2.disconnect();
    await noOffline;
  });
});

describe('authorization over sockets', () => {
  test('outsiders cannot send, type, join or mark messages in a foreign conversation', async () => {
    const freshEve = (await request.post('/api/auth/login').send({ email: eve.user.email, password: eve.password })).body;
    const e = await connect({ token: freshEve.accessToken });
    const b = await connect(bob);

    const noLeak = expectNoEvent(b, 'typing', 400);
    for (const [event, payload] of [
      ['message:send', { conversationId: conversation.id, body: 'intrusion' }],
      ['typing:start', { conversationId: conversation.id }],
      ['conversation:join', { conversationId: conversation.id }],
      ['message:read', { conversationId: conversation.id }],
      ['message:delivered', { conversationId: conversation.id }],
    ]) {
      const ack = await emitAck(e, event, payload);
      assert.equal(ack.ok, false, event);
      assert.equal(ack.error.code, 'NOT_FOUND', event);
    }
    await noLeak;

    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM messages WHERE body = ?', ['intrusion']);
    assert.equal(rows[0].n, 0);
  });

  test('outsiders do not receive messages of other conversations', async () => {
    const freshEve = (await request.post('/api/auth/login').send({ email: eve.user.email, password: eve.password })).body;
    const e = await connect({ token: freshEve.accessToken });
    const a = await connect(alice);
    const noLeak = expectNoEvent(e, 'message:new', 400);
    await emitAck(a, 'message:send', { conversationId: conversation.id, body: 'private' });
    await noLeak;
  });
});

describe('reconnection', () => {
  test('a client can catch up on missed messages and resend idempotently', async () => {
    const a = await connect(alice);
    const history = await request.get(`/api/conversations/${conversation.id}/messages`).set(auth(bob.token)).expect(200);
    const lastSeenId = history.body.messages.at(-1).id;

    // Bob is offline while Alice sends.
    await emitAck(a, 'message:send', { conversationId: conversation.id, body: 'missed 1' });
    await emitAck(a, 'message:send', { conversationId: conversation.id, body: 'missed 2' });

    // Bob reconnects and fetches everything after the last message he had.
    await connect(bob);
    const catchUp = await request
      .get(`/api/conversations/${conversation.id}/messages?after=${lastSeenId}`)
      .set(auth(bob.token))
      .expect(200);
    assert.deepEqual(catchUp.body.messages.map((m) => m.body), ['missed 1', 'missed 2']);

    // Alice's client resends an unacknowledged message after reconnecting: no duplicate.
    const first = await emitAck(a, 'message:send', { conversationId: conversation.id, body: 'once', clientId: 'resend-0001' });
    const again = await emitAck(a, 'message:send', { conversationId: conversation.id, body: 'once', clientId: 'resend-0001' });
    assert.equal(first.data.message.id, again.data.message.id);
  });
});
