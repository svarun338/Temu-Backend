import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auth, closeAll, connectUsers, emitAck, pool, registerUser, resetDatabase, startServer, waitFor } from './helpers.js';

let server;
let request;
let alice;
let bob;
let carol;
let ab;
let ac;

const HERE = { latitude: 28.613939, longitude: 77.209023, accuracy: 12 };

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice Maps' });
  bob = await registerUser(request, { name: 'Bob Maps' });
  carol = await registerUser(request, { name: 'Carol Maps' });
  ab = await connectUsers(request, alice, bob);
  ac = await connectUsers(request, alice, carol);
});

after(async () => {
  await server.close();
  await closeAll();
});

const sendLocation = (user, conversation, location, body = '') =>
  request.post(`/api/conversations/${conversation.id}/messages`).set(auth(user.token)).send({ body, location });

describe('sharing a location', () => {
  test('a current location is sent and shown in history and the chat preview', async () => {
    const res = await sendLocation(alice, ab, HERE).expect(201);
    const { location } = res.body.message;
    assert.deepEqual(
      { lat: location.latitude, lng: location.longitude, acc: location.accuracy, live: location.live, active: location.active },
      { lat: HERE.latitude, lng: HERE.longitude, acc: 12, live: false, active: false },
    );

    const history = (await request.get(`/api/conversations/${ab.id}/messages`).set(auth(bob.token)).expect(200)).body.messages;
    assert.equal(history.at(-1).location.latitude, HERE.latitude);
    const preview = (await request.get('/api/conversations').set(auth(bob.token))).body.conversations.find((c) => c.id === ab.id);
    assert.deepEqual(preview.lastMessage.location, { live: false, summaryOnly: true });
  });

  test('works over sockets and arrives live', async () => {
    const aliceSocket = await server.connect(alice.token);
    const bobSocket = await server.connect(bob.token);
    const received = waitFor(bobSocket, 'message:new', (m) => m.location?.latitude === 51.5);
    const ack = await emitAck(aliceSocket, 'message:send', { conversationId: ab.id, location: { latitude: 51.5, longitude: -0.12 } });
    assert.equal(ack.ok, true);
    await received;
    aliceSocket.disconnect();
    bobSocket.disconnect();
  });

  test('rejects impossible coordinates, odd durations, and locations with files', async () => {
    await sendLocation(alice, ab, { latitude: 91, longitude: 0 }).expect(422);
    await sendLocation(alice, ab, { latitude: 0, longitude: -181 }).expect(422);
    await sendLocation(alice, ab, { latitude: '12', longitude: 0 }).expect(422);
    await sendLocation(alice, ab, { ...HERE, liveMinutes: 999 }).expect(422);
    await request.post(`/api/conversations/${ab.id}/messages`).set(auth(alice.token)).send({ location: HERE, attachmentIds: [1] }).expect(400);
  });

  test('outsiders cannot post locations into a chat', async () => {
    await sendLocation(carol, ab, HERE).expect(404);
  });
});

describe('live location', () => {
  test('the sender moves it, everyone in the chat sees it move, then stops it', async () => {
    const message = (await sendLocation(alice, ab, { ...HERE, liveMinutes: 15 }).expect(201)).body.message;
    assert.equal(message.location.live, true);
    assert.equal(message.location.active, true);
    assert.ok(new Date(message.location.liveUntil) - Date.now() > 14 * 60_000);

    const aliceSocket = await server.connect(alice.token);
    const bobSocket = await server.connect(bob.token);
    const moved = waitFor(bobSocket, 'location:updated', (e) => e.messageId === message.id && e.location.latitude === 28.62);
    const ack = await emitAck(aliceSocket, 'location:update', { messageId: message.id, latitude: 28.62, longitude: 77.21, accuracy: 8 });
    assert.equal(ack.ok, true);
    assert.equal((await moved).location.accuracy, 8);

    const live = (await request.get('/api/messages/live-locations').set(auth(alice.token)).expect(200)).body.locations;
    assert.deepEqual(live.map((l) => l.messageId), [message.id]);

    const stopped = waitFor(bobSocket, 'location:updated', (e) => e.messageId === message.id && !e.location.active);
    await emitAck(aliceSocket, 'location:stop', { messageId: message.id });
    assert.ok((await stopped).location.stoppedAt);

    const late = await emitAck(aliceSocket, 'location:update', { messageId: message.id, latitude: 1, longitude: 1 });
    assert.equal(late.ok, false);
    assert.equal(late.error.code, 'LOCATION_NOT_LIVE');
    assert.equal((await request.get('/api/messages/live-locations').set(auth(alice.token))).body.locations.length, 0);
    aliceSocket.disconnect();
    bobSocket.disconnect();
  });

  test('only the sender can move or stop it', async () => {
    const message = (await sendLocation(alice, ab, { ...HERE, liveMinutes: 60 }).expect(201)).body.message;
    await request.patch(`/api/messages/${message.id}/location`).set(auth(bob.token)).send({ latitude: 0, longitude: 0 }).expect(403);
    await request.delete(`/api/messages/${message.id}/location/live`).set(auth(bob.token)).expect(403);
    await request.patch(`/api/messages/${message.id}/location`).set(auth(carol.token)).send({ latitude: 0, longitude: 0 }).expect(404);
    await request.patch(`/api/messages/${message.id}/location`).set(auth(alice.token)).send({ latitude: 1.5, longitude: 2.5 }).expect(200);
  });

  test('expires on its own', async () => {
    const message = (await sendLocation(alice, ab, { ...HERE, liveMinutes: 15 }).expect(201)).body.message;
    await pool.query('UPDATE message_locations SET live_until = NOW(3) - INTERVAL 1 SECOND WHERE message_id = ?', [message.id]);
    const res = await request.patch(`/api/messages/${message.id}/location`).set(auth(alice.token)).send({ latitude: 0, longitude: 0 }).expect(409);
    assert.equal(res.body.error.code, 'LOCATION_NOT_LIVE');
    const history = (await request.get(`/api/conversations/${ab.id}/messages?limit=100`).set(auth(bob.token))).body.messages;
    assert.equal(history.find((m) => m.id === message.id).location.active, false);
  });

  test('cannot be updated across a block', async () => {
    const message = (await sendLocation(alice, ab, { ...HERE, liveMinutes: 15 }).expect(201)).body.message;
    await request.post('/api/blocks').set(auth(bob.token)).send({ userId: alice.user.id }).expect(201);
    await request.patch(`/api/messages/${message.id}/location`).set(auth(alice.token)).send({ latitude: 0, longitude: 0 }).expect(403);
    await request.delete(`/api/blocks/${alice.user.id}`).set(auth(bob.token)).expect(204);
  });
});

describe('location with other message actions', () => {
  test('forwarding a live location sends a static pin', async () => {
    const live = (await sendLocation(alice, ab, { ...HERE, liveMinutes: 60 }).expect(201)).body.message;
    const res = await request.post(`/api/messages/${live.id}/forward`).set(auth(alice.token)).send({ conversationIds: [ac.id] }).expect(201);
    const copy = res.body.messages[0].location;
    assert.equal(copy.live, false);
    assert.equal(copy.latitude, HERE.latitude);
  });

  test('delete for everyone removes the location', async () => {
    const message = (await sendLocation(alice, ab, { ...HERE, liveMinutes: 15 }).expect(201)).body.message;
    const res = await request.delete(`/api/messages/${message.id}?scope=everyone`).set(auth(alice.token)).expect(200);
    assert.equal(res.body.message.location, null);
    const [rows] = await pool.query('SELECT 1 FROM message_locations WHERE message_id = ?', [message.id]);
    assert.equal(rows.length, 0, 'coordinates are erased from the database');
  });

  test('a reply to a location says so in the quote', async () => {
    const pin = (await sendLocation(alice, ab, HERE).expect(201)).body.message;
    const res = await request
      .post(`/api/conversations/${ab.id}/messages`)
      .set(auth(bob.token))
      .send({ body: 'On my way', replyToId: pin.id })
      .expect(201);
    assert.equal(res.body.message.replyTo.locationKind, 'static');
  });
});
