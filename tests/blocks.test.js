import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auth,
  closeAll,
  connectUsers,
  emitAck,
  expectNoEvent,
  registerUser,
  resetDatabase,
  startServer,
  waitFor,
} from './helpers.js';

let server;
let request;
let alice;
let bob;
let conversation;

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice Blocker' });
  bob = await registerUser(request, { name: 'Bob Blocked' });
  conversation = await connectUsers(request, alice, bob);
});

after(async () => {
  await server.close();
  await closeAll();
});

// Each test starts unblocked.
afterEach(async () => {
  await request.delete(`/api/blocks/${bob.user.id}`).set(auth(alice.token));
  await request.delete(`/api/blocks/${alice.user.id}`).set(auth(bob.token));
});

const block = (who, target) => request.post('/api/blocks').set(auth(who.token)).send({ userId: target.user.id });

describe('blocking', () => {
  test('block, list and unblock', async () => {
    await block(alice, bob).expect(201);
    await block(alice, bob).expect(200); // idempotent
    const list = await request.get('/api/blocks').set(auth(alice.token)).expect(200);
    assert.deepEqual(list.body.blocked.map((u) => u.id), [bob.user.id]);

    await request.delete(`/api/blocks/${bob.user.id}`).set(auth(alice.token)).expect(204);
    await request.delete(`/api/blocks/${bob.user.id}`).set(auth(alice.token)).expect(404);
  });

  test('cannot block yourself or a missing user', async () => {
    await block(alice, alice).expect(400);
    await request.post('/api/blocks').set(auth(alice.token)).send({ userId: 999999 }).expect(404);
  });

  test('neither side can send messages, over REST or sockets', async () => {
    await block(alice, bob).expect(201);

    const byBlocker = await request
      .post(`/api/conversations/${conversation.id}/messages`)
      .set(auth(alice.token))
      .send({ body: 'hi' })
      .expect(403);
    assert.equal(byBlocker.body.error.code, 'BLOCKED');

    const byBlocked = await request
      .post(`/api/conversations/${conversation.id}/messages`)
      .set(auth(bob.token))
      .send({ body: 'hi' })
      .expect(403);
    // The blocked person is not told they were blocked.
    assert.equal(byBlocked.body.error.code, 'CANNOT_MESSAGE');

    const bobSocket = await server.connect(bob.token);
    const ack = await emitAck(bobSocket, 'message:send', { conversationId: conversation.id, body: 'sneaky' });
    assert.equal(ack.ok, false);
    assert.equal(ack.error.code, 'CANNOT_MESSAGE');
    bobSocket.disconnect();
  });

  test('message history stays readable after blocking', async () => {
    await request.post(`/api/conversations/${conversation.id}/messages`).set(auth(bob.token)).send({ body: 'before block' }).expect(201);
    await block(alice, bob).expect(201);
    const res = await request.get(`/api/conversations/${conversation.id}/messages`).set(auth(alice.token)).expect(200);
    assert.ok(res.body.messages.some((m) => m.body === 'before block'));
  });

  test('typing is not relayed across a block', async () => {
    await block(alice, bob).expect(201);
    const aliceSocket = await server.connect(alice.token);
    const bobSocket = await server.connect(bob.token);
    const none = expectNoEvent(aliceSocket, 'typing', 300);
    await emitAck(bobSocket, 'typing:start', { conversationId: conversation.id });
    await none;
    aliceSocket.disconnect();
    bobSocket.disconnect();
  });

  test('presence, last seen and profile photo are hidden from the blocked user', async () => {
    await request.patch('/api/profile').set(auth(alice.token)).send({ about: 'Private about' }).expect(200);
    await block(alice, bob).expect(201);
    const aliceSocket = await server.connect(alice.token);

    const convs = await request.get('/api/conversations').set(auth(bob.token)).expect(200);
    const peer = convs.body.conversations[0].peer;
    assert.equal(peer.isOnline, false, 'blocked user sees the blocker as offline');
    assert.equal(peer.lastSeenAt, null);
    assert.equal(peer.about, null);
    assert.equal(peer.avatarUrl, null);

    // Blocker's own view: Bob is marked as blocked.
    const mine = await request.get('/api/conversations').set(auth(alice.token)).expect(200);
    assert.equal(mine.body.conversations[0].peer.isBlocked, true);
    aliceSocket.disconnect();
  });

  test('the blocked user gets no live presence updates from the blocker', async () => {
    await block(alice, bob).expect(201);
    const bobSocket = await server.connect(bob.token);
    const none = expectNoEvent(bobSocket, 'presence:update', 400);
    const aliceSocket = await server.connect(alice.token);
    await none;
    aliceSocket.disconnect();
    bobSocket.disconnect();
  });

  test('blocking updates both sides live, and unblocking restores visibility', async () => {
    const aliceSocket = await server.connect(alice.token);
    const bobSocket = await server.connect(bob.token);

    const blockedEvent = waitFor(aliceSocket, 'block:updated', (e) => e.userId === bob.user.id && e.blocked);
    const hiddenPresence = waitFor(bobSocket, 'presence:update', (e) => e.userId === alice.user.id && !e.isOnline);
    await block(alice, bob).expect(201);
    await blockedEvent;
    await hiddenPresence;

    const unblockedEvent = waitFor(aliceSocket, 'block:updated', (e) => e.userId === bob.user.id && !e.blocked);
    const restored = waitFor(bobSocket, 'presence:update', (e) => e.userId === alice.user.id && e.isOnline);
    await request.delete(`/api/blocks/${bob.user.id}`).set(auth(alice.token)).expect(204);
    await unblockedEvent;
    await restored;

    aliceSocket.disconnect();
    bobSocket.disconnect();
  });

  test('users who blocked you disappear from search, and cannot be added or opened', async () => {
    const carol = await registerUser(request, { name: 'Carol Stranger' });
    await block(carol, bob).expect(201);

    const search = await request.get('/api/users/search?q=carol').set(auth(bob.token)).expect(200);
    assert.equal(search.body.users.length, 0);
    await request.get(`/api/users/${carol.user.id}`).set(auth(bob.token)).expect(404);
    await request.post('/api/contacts').set(auth(bob.token)).send({ userId: carol.user.id }).expect(404);

    // Carol can still find Bob (to unblock him) and sees him flagged as blocked.
    const hers = await request.get('/api/users/search?q=bob').set(auth(carol.token)).expect(200);
    assert.equal(hers.body.users[0].isBlocked, true);
    await request.delete(`/api/blocks/${bob.user.id}`).set(auth(carol.token)).expect(204);
  });

  test('a new conversation cannot be started across a block', async () => {
    const dave = await registerUser(request, { name: 'Dave New' });
    await request.post('/api/contacts').set(auth(alice.token)).send({ userId: dave.user.id }).expect(201);
    await block(alice, dave).expect(201);
    const res = await request.post('/api/conversations').set(auth(alice.token)).send({ userId: dave.user.id }).expect(403);
    assert.equal(res.body.error.code, 'BLOCKED');
  });
});
