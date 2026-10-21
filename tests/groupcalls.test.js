import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auth, closeAll, emitAck, expectNoEvent, pool, registerUser, resetDatabase, startServer, waitFor } from './helpers.js';

let server;
let request;
let users; // alice (group owner), bob, carol, dave, erin, frank, gina: all in the group
let olly; // not in the group
let group; // conversation
let aliceErin; // a one-to-one chat
let open = [];

const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina'];
const tab = (name) => `${name}-tab-0123456789`;

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  users = {};
  for (const name of NAMES) users[name] = await registerUser(request, { name: name[0].toUpperCase() + name.slice(1) });
  olly = await registerUser(request, { name: 'Olly Outsider' });
  for (const name of NAMES.slice(1)) {
    await request.post('/api/contacts').set(auth(users.alice.token)).send({ userId: users[name].user.id }).expect(201);
  }
  const res = await request
    .post('/api/groups')
    .set(auth(users.alice.token))
    .send({ name: 'Weekend plans', memberIds: NAMES.slice(1).map((name) => users[name].user.id) })
    .expect(201);
  group = res.body.conversation;
  // Alice already has Erin as a contact; Erin adds Alice and they open a one-to-one chat.
  await request.post('/api/contacts').set(auth(users.erin.token)).send({ userId: id('alice') }).expect(201);
  aliceErin = (await request.post('/api/conversations').set(auth(users.alice.token)).send({ userId: id('erin') }).expect(201)).body.conversation;
});

beforeEach(async () => {
  for (const socket of open) socket.disconnect();
  open = [];
  await new Promise((resolve) => setTimeout(resolve, 1200)); // leftover calls end (grace period is 1 s in tests)
});

after(async () => {
  await server.close();
  await closeAll();
});

async function connect(name, suffix = '') {
  const user = name === 'olly' ? olly : users[name];
  const socket = await server.connect(user.token, { auth: { token: user.token, tabId: tab(name + suffix) } });
  open.push(socket);
  return socket;
}

async function connectAll(names) {
  const sockets = {};
  for (const name of names) sockets[name] = await connect(name);
  return sockets;
}

const id = (name) => users[name].user.id;
const start = (socket, type = 'video', conversationId = group.id) => emitAck(socket, 'groupcall:start', { conversationId, type });
const join = (socket, callId) => emitAck(socket, 'groupcall:join', { callId });
const leave = (socket, callId) => emitAck(socket, 'groupcall:leave', { callId });

/** Alice starts a call and `names` join, in that order. */
async function callWith(names, type = 'video') {
  const s = await connectAll(['alice', ...names]);
  const started = await start(s.alice, type);
  assert.equal(started.ok, true, JSON.stringify(started.error));
  const callId = started.data.call.id;
  for (const name of names) assert.equal((await join(s[name], callId)).ok, true);
  return { s, callId };
}

describe('starting a group call', () => {
  test('a member starts it, everyone else in the group rings, and it shows as active', async () => {
    const s = await connectAll(['alice', 'bob', 'carol', 'olly']);
    const bobRings = waitFor(s.bob, 'groupcall:incoming');
    const carolSees = waitFor(s.carol, 'groupcall:updated');
    const outsiderHearsNothing = expectNoEvent(s.olly, 'groupcall:incoming', 300);

    const started = await start(s.alice, 'video');
    assert.equal(started.ok, true, JSON.stringify(started.error));
    const call = started.data.call;
    assert.equal(call.status, 'ringing');
    assert.equal(call.hostId, id('alice'));
    assert.equal(call.maxParticipants, 6);
    assert.deepEqual(call.group, { id: group.id, name: 'Weekend plans', avatarUrl: null });
    assert.deepEqual(call.participants.map((p) => p.id), [id('alice')]);
    assert.ok(started.data.iceServers.length > 0);

    const incoming = await bobRings;
    assert.equal(incoming.call.id, call.id);
    assert.equal(incoming.call.startedBy.name, 'Alice');
    await carolSees;
    await outsiderHearsNothing;

    const active = await request.get('/api/calls/active').set(auth(users.carol.token)).expect(200);
    assert.deepEqual(active.body.calls.map((c) => c.id), [call.id]);
    assert.deepEqual((await request.get('/api/calls/active').set(auth(olly.token)).expect(200)).body.calls, []);

    // One call per group: a second start is told to join instead.
    const second = await start(s.bob, 'voice');
    assert.equal(second.error.code, 'CALL_IN_PROGRESS');
    assert.deepEqual(second.error.details, { callId: call.id });
    await leave(s.alice, call.id);
  });

  test('opening the app during a call: it rings while still ringing, and always shows "Join"', async () => {
    const s = await connectAll(['alice', 'bob']);
    const { data } = await start(s.alice);
    const callId = data.call.id;

    // Carol opens the app while it rings: she gets the ring and the call.
    let carolRing;
    let carolCall;
    const carol = await server.connect(users.carol.token, {
      auth: { token: users.carol.token, tabId: tab('carol') },
      onSocket: (socket) => {
        carolRing = waitFor(socket, 'groupcall:incoming');
        carolCall = waitFor(socket, 'groupcall:updated');
      },
    });
    open.push(carol);
    assert.equal((await carolRing).call.id, callId);
    assert.equal((await carolCall).call.id, callId);

    // After the ringing time (1 s in tests), Dave opening the app sees the call but doesn't ring.
    await join(s.bob, callId);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    let daveRing;
    let daveCall;
    const dave = await server.connect(users.dave.token, {
      auth: { token: users.dave.token, tabId: tab('dave') },
      onSocket: (socket) => {
        daveRing = expectNoEvent(socket, 'groupcall:incoming', 400);
        daveCall = waitFor(socket, 'groupcall:updated');
      },
    });
    open.push(dave);
    assert.deepEqual((await daveCall).call.participants.map((p) => p.id), [id('alice'), id('bob')]);
    await daveRing;
    await leave(s.alice, callId);
  });

  test('only group members, only in group chats, and not while already in a call', async () => {
    const s = await connectAll(['alice', 'olly']);
    assert.equal((await start(s.olly)).error.code, 'NOT_FOUND');
    assert.equal((await start(s.alice, 'video', aliceErin.id)).error.code, 'BAD_REQUEST');
    assert.equal((await emitAck(s.alice, 'groupcall:start', { conversationId: group.id, type: 'screen' })).error.code, 'VALIDATION_ERROR');
    // The one-to-one call event refuses groups as before.
    assert.equal((await emitAck(s.alice, 'call:start', { conversationId: group.id, type: 'voice' })).error.code, 'BAD_REQUEST');
  });
});

describe('joining', () => {
  test('joining connects the call; the people already in it are told, with who joined', async () => {
    const s = await connectAll(['alice', 'bob', 'carol']);
    const { data } = await start(s.alice);
    const callId = data.call.id;

    const aliceSeesBob = waitFor(s.alice, 'groupcall:joined');
    const joined = await join(s.bob, callId);
    assert.equal(joined.data.call.status, 'ongoing');
    assert.deepEqual(joined.data.call.participants.map((p) => p.id), [id('alice'), id('bob')]);
    assert.equal((await aliceSeesBob).participant.id, id('bob'));

    const bothSeeCarol = Promise.all([waitFor(s.alice, 'groupcall:joined'), waitFor(s.bob, 'groupcall:joined')]);
    await join(s.carol, callId);
    for (const event of await bothSeeCarol) assert.equal(event.participant.name, 'Carol');

    const [[row]] = await pool.query('SELECT status, is_group, callee_id, answered_at FROM calls WHERE id = ?', [callId]);
    assert.equal(row.status, 'ongoing');
    assert.equal(row.is_group, 1);
    assert.equal(row.callee_id, null);
    assert.ok(row.answered_at);
    const [people] = await pool.query('SELECT user_id FROM call_participants WHERE call_id = ? AND joined_at IS NOT NULL ORDER BY joined_at', [callId]);
    assert.deepEqual(people.map((p) => p.user_id), [id('alice'), id('bob'), id('carol')]);
    await leave(s.alice, callId);
  });

  test('answering on one tab stops the other tabs ringing; declining only stops my own ringing', async () => {
    const s = await connectAll(['alice', 'bob', 'carol']);
    const bobPhone = await connect('bob', '-phone');
    const ringing = waitFor(bobPhone, 'groupcall:incoming');
    const { data } = await start(s.alice);
    await ringing;
    const handled = waitFor(bobPhone, 'groupcall:handled');
    await join(s.bob, data.call.id);
    assert.deepEqual(await handled, { callId: data.call.id });

    const carolStops = waitFor(s.carol, 'groupcall:handled');
    assert.equal((await emitAck(s.carol, 'groupcall:decline', { callId: data.call.id })).ok, true);
    await carolStops;
    // Declining doesn't close the door: Carol can still join.
    assert.equal((await join(s.carol, data.call.id)).ok, true);
    await leave(s.alice, data.call.id);
  });

  test('a call holds at most 6 people', async () => {
    const { s, callId } = await callWith(['bob', 'carol', 'dave', 'erin', 'frank']);
    s.gina = await connect('gina');
    const full = await join(s.gina, callId);
    assert.equal(full.error.code, 'CALL_FULL');
    // When someone leaves there is room again.
    await leave(s.frank, callId);
    assert.equal((await join(s.gina, callId)).ok, true);
    await leave(s.alice, callId);
  });

  test('six people joining at the very same moment: exactly the free places are taken', async () => {
    const s = await connectAll(NAMES);
    const { data } = await start(s.alice);
    const results = await Promise.all(NAMES.slice(1).map((name) => join(s[name], data.call.id)));
    assert.equal(results.filter((r) => r.ok).length, 5);
    assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.error.code), ['CALL_FULL']);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM call_participants WHERE call_id = ? AND joined_at IS NOT NULL', [data.call.id]);
    assert.equal(n, 6);
    await leave(s.alice, data.call.id);
  });

  test('people busy in another call do not ring and cannot join until they are free', async () => {
    const s = await connectAll(['alice', 'bob', 'erin']);
    // Alice and Erin are on a one-to-one call.
    const erinRings = waitFor(s.erin, 'call:incoming');
    const direct = await emitAck(s.alice, 'call:start', { conversationId: aliceErin.id, type: 'voice' });
    await erinRings;
    await emitAck(s.erin, 'call:accept', { callId: direct.data.call.id });

    // Alice and Erin are busy; Bob starts the group call.
    const erinNoRing = expectNoEvent(s.erin, 'groupcall:incoming', 300);
    const erinSeesIt = waitFor(s.erin, 'groupcall:updated');
    const { data } = await start(s.bob);
    await erinNoRing;
    await erinSeesIt;
    assert.equal((await join(s.erin, data.call.id)).error.code, 'ALREADY_IN_CALL');
    assert.equal((await join(s.alice, data.call.id)).error.code, 'ALREADY_IN_CALL');

    // And the other way round: someone in a group call is busy for one-to-one calls.
    await emitAck(s.alice, 'call:end', { callId: direct.data.call.id });
    assert.equal((await join(s.alice, data.call.id)).ok, true);
    const busy = await emitAck(s.erin, 'call:start', { conversationId: aliceErin.id, type: 'voice' });
    assert.equal(busy.data.call.status, 'busy');
    await leave(s.bob, data.call.id);
  });
});

describe('signalling', () => {
  test('offers, answers and candidates reach exactly the named participant', async () => {
    const { s, callId } = await callWith(['bob', 'carol']);
    const offer = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
    const bobGets = waitFor(s.bob, 'groupcall:signal');
    const carolGetsNothing = expectNoEvent(s.carol, 'groupcall:signal', 300);
    assert.equal((await emitAck(s.alice, 'groupcall:signal', { callId, to: id('bob'), data: offer })).ok, true);
    assert.deepEqual(await bobGets, { callId, from: id('alice'), data: offer });
    await carolGetsNothing;

    // Not to someone outside the call, not from someone outside it, not junk.
    assert.equal((await emitAck(s.alice, 'groupcall:signal', { callId, to: id('dave'), data: offer })).error.code, 'NOT_FOUND');
    const olly = await connect('olly');
    assert.equal((await emitAck(olly, 'groupcall:signal', { callId, to: id('bob'), data: offer })).error.code, 'NOT_FOUND');
    assert.equal((await emitAck(s.alice, 'groupcall:signal', { callId, to: id('bob'), data: { type: 'hack' } })).error.code, 'VALIDATION_ERROR');
    // Only from the tab that joined.
    const alicePhone = await connect('alice', '-phone');
    assert.equal((await emitAck(alicePhone, 'groupcall:signal', { callId, to: id('bob'), data: offer })).error.code, 'NOT_FOUND');
    await leave(s.alice, callId);
  });
});

describe('leaving and the host', () => {
  test('the host leaving passes the role to the next person who joined; the call ends when one is left', async () => {
    const { s, callId } = await callWith(['bob', 'carol']);
    const bobHears = Promise.all([waitFor(s.bob, 'groupcall:left'), waitFor(s.bob, 'groupcall:host')]);
    const carolHost = waitFor(s.carol, 'groupcall:host');
    await leave(s.alice, callId);
    const [left, host] = await bobHears;
    assert.deepEqual(left, { callId, userId: id('alice') });
    assert.deepEqual(host, { callId, hostId: id('bob'), previousHostId: id('alice') });
    await carolHost;

    // Bob (host) records; Carol can't.
    assert.equal((await request.post(`/api/calls/${callId}/recordings`).set(auth(users.carol.token)).send({ kind: 'video', mimeType: 'video/webm' })).status, 403);
    const carolTold = waitFor(s.carol, 'call:recording', (e) => e.recording);
    await request.post(`/api/calls/${callId}/recordings`).set(auth(users.bob.token)).send({ kind: 'video', mimeType: 'video/webm' }).expect(201);
    assert.equal((await carolTold).userId, id('bob'));

    const ended = waitFor(s.dave = await connect('dave'), 'groupcall:ended');
    const note = waitFor(s.dave, 'message:new', (m) => m.event?.type === 'call' && m.event.data.callId === callId);
    await leave(s.carol, callId); // only Bob left: the call ends for him too
    assert.deepEqual(await ended, { callId, conversationId: group.id, status: 'ended' });
    const message = await note;
    assert.equal(message.senderId, id('alice'));
    assert.equal(message.event.data.group, true);
    assert.equal(message.event.data.status, 'ended');
    assert.deepEqual(message.event.data.participantIds, [id('alice'), id('bob'), id('carol')]);

    // History: Bob took part; Dave was rung and missed it. The group is the "peer".
    const bobLog = (await request.get('/api/calls').set(auth(users.bob.token)).expect(200)).body.calls.find((c) => c.id === callId);
    assert.equal(bobLog.status, 'ended');
    assert.equal(bobLog.group, true);
    assert.equal(bobLog.peer.name, 'Weekend plans');
    const daveLog = (await request.get('/api/calls').set(auth(users.dave.token)).expect(200)).body.calls.find((c) => c.id === callId);
    assert.equal(daveLog.status, 'missed');
    assert.equal(daveLog.durationSec, 0);
    assert.equal((await request.get('/api/calls').set(auth(olly.token)).expect(200)).body.calls.length, 0);
    // Hiding works for group calls too.
    await request.post('/api/calls/hide').set(auth(users.dave.token)).send({ callIds: [callId] }).expect(204);
    assert.equal((await request.get('/api/calls').set(auth(users.dave.token)).expect(200)).body.calls.find((c) => c.id === callId), undefined);
  });

  test('a dropped connection hands the host role on at once, and the person is removed after the grace period', async () => {
    const { s, callId } = await callWith(['bob', 'carol']);
    const host = waitFor(s.bob, 'groupcall:host');
    const left = waitFor(s.bob, 'groupcall:left', () => true, 3000);
    s.alice.disconnect();
    assert.equal((await host).hostId, id('bob'));
    assert.deepEqual(await left, { callId, userId: id('alice') }); // CALL_RECONNECT_GRACE_SECONDS = 1
    await leave(s.bob, callId);
  });

  test('coming back within the grace period keeps you in the call (as a participant, not host)', async () => {
    const { s, callId } = await callWith(['bob', 'carol']);
    const host = waitFor(s.bob, 'groupcall:host');
    const noLeave = expectNoEvent(s.bob, 'groupcall:left', 1500);
    s.alice.disconnect();
    await host;
    let resumed;
    const back = await server.connect(users.alice.token, {
      auth: { token: users.alice.token, tabId: tab('alice') },
      onSocket: (socket) => (resumed = waitFor(socket, 'groupcall:resumed')),
    });
    open.push(back);
    const event = await resumed;
    assert.equal(event.hostId, id('bob'));
    assert.deepEqual(event.call.participants.map((p) => p.id), [id('alice'), id('bob'), id('carol')]);
    await noLeave;
    await leave(back, callId);
    await leave(s.bob, callId);
  });

  test('leaving the group leaves its call', async () => {
    const { s, callId } = await callWith(['bob', 'carol', 'gina']);
    const ginaLeft = waitFor(s.bob, 'groupcall:left', (e) => e.userId === id('gina'));
    await request.post(`/api/groups/${group.id}/leave`).set(auth(users.gina.token)).expect(204);
    await ginaLeft;
    await leave(s.alice, callId);
    // Back in the group for the other tests.
    await request.post(`/api/groups/${group.id}/members`).set(auth(users.alice.token)).send({ userIds: [id('gina')] }).expect(200);
  });
});

describe('nobody answers', () => {
  test('a call nobody joins is missed after the ringing time', async () => {
    const s = await connectAll(['alice', 'bob']);
    const ended = waitFor(s.bob, 'groupcall:ended', () => true, 3000);
    const { data } = await start(s.alice, 'voice');
    assert.deepEqual(await ended, { callId: data.call.id, conversationId: group.id, status: 'missed' }); // CALL_RING_SECONDS = 1
    const [[row]] = await pool.query('SELECT status FROM calls WHERE id = ?', [data.call.id]);
    assert.equal(row.status, 'missed');
  });

  test('if everyone declines, the call ends straight away', async () => {
    const s = await connectAll(NAMES);
    const { data } = await start(s.alice, 'voice');
    const ended = waitFor(s.alice, 'groupcall:ended');
    for (const name of NAMES.slice(1)) await emitAck(s[name], 'groupcall:decline', { callId: data.call.id });
    assert.equal((await ended).status, 'missed');
  });
});

describe('group receipts', () => {
  test('a read receipt reaches the whole group only when everyone has read; otherwise just my own tabs', async () => {
    const s = await connectAll(NAMES);
    const carolPhone = await connect('carol', '-phone');
    const { data } = await emitAck(s.alice, 'message:send', { conversationId: group.id, body: 'did everyone see this?' });
    const messageId = data.message.id;

    // Six people still haven't read it: Carol reading changes nothing for Alice's ticks.
    const aliceHearsNothing = expectNoEvent(s.alice, 'message:status', 400);
    const bobHearsNothing = expectNoEvent(s.bob, 'message:status', 400);
    const carolOtherTab = waitFor(carolPhone, 'message:status', (r) => r.status === 'read');
    await emitAck(s.carol, 'message:read', { conversationId: group.id, messageId });
    const mine = await carolOtherTab;
    assert.equal(mine.byUserId, id('carol'));
    assert.equal(mine.toGroup, undefined); // internal flag never leaves the server
    await aliceHearsNothing;
    await bobHearsNothing;

    // Everyone else reads: the last one moves the group-wide point, and Alice sees "read".
    const aliceTicks = waitFor(s.alice, 'message:status', (r) => r.status === 'read' && r.upToMessageId >= messageId);
    for (const name of ['bob', 'dave', 'erin', 'frank', 'gina']) {
      await emitAck(s[name], 'message:read', { conversationId: group.id, messageId });
    }
    const receipt = await aliceTicks;
    assert.equal(receipt.group, true);
  });
});

describe('group chat under concurrency (no deadlocks)', () => {
  test('everyone sending, reading and the admins changing the group at the same time', async () => {
    const s = await connectAll(NAMES);
    const sends = NAMES.flatMap((name) =>
      Array.from({ length: 12 }, (_, i) => emitAck(s[name], 'message:send', { conversationId: group.id, body: `${name} ${i}` })),
    );
    const receipts = NAMES.flatMap((name) =>
      Array.from({ length: 6 }, (_, i) =>
        emitAck(s[name], i % 2 ? 'message:read' : 'message:delivered', { conversationId: group.id }),
      ),
    );
    const changes = [
      request.patch(`/api/groups/${group.id}`).set(auth(users.alice.token)).send({ description: 'Busy group' }),
      request.patch(`/api/groups/${group.id}`).set(auth(users.alice.token)).send({ name: 'Weekend plans' }),
      request.patch(`/api/groups/${group.id}/members/${id('bob')}`).set(auth(users.alice.token)).send({ role: 'admin' }),
    ];
    const [sent, read, changed] = await Promise.all([Promise.all(sends), Promise.all(receipts), Promise.all(changes)]);
    assert.deepEqual(sent.filter((a) => !a.ok).map((a) => a.error), []);
    assert.deepEqual(read.filter((a) => !a.ok && a.error.code !== 'NOT_FOUND').map((a) => a.error), []);
    assert.deepEqual(changed.map((r) => r.status).filter((status) => status >= 400), []);

    const ids = sent.map((a) => a.data.message.id);
    const [[row]] = await pool.query('SELECT last_message_id FROM conversations WHERE id = ?', [group.id]);
    assert.ok(row.last_message_id >= Math.max(...ids));
  });

  test('a group call starting and people joining and leaving while the group chats', async () => {
    const s = await connectAll(NAMES);
    const { data } = await start(s.alice);
    const callId = data.call.id;
    await join(s.bob, callId); // Bob stays, so the call never drops to one person (which would end it)
    const traffic = NAMES.flatMap((name) =>
      Array.from({ length: 6 }, (_, i) => emitAck(s[name], 'message:send', { conversationId: group.id, body: `during call ${i}` })),
    );
    const movement = NAMES.slice(2, 6).map(async (name) => {
      await join(s[name], callId);
      await leave(s[name], callId);
      return join(s[name], callId);
    });
    const [msgs, moves] = await Promise.all([Promise.all(traffic), Promise.all(movement)]);
    assert.deepEqual(msgs.filter((a) => !a.ok).map((a) => a.error), []);
    assert.deepEqual(moves.filter((a) => !a.ok).map((a) => a.error), []);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM call_participants WHERE call_id = ? AND joined_at IS NOT NULL AND left_at IS NULL', [callId]);
    assert.equal(n, 6); // Alice, Bob and the four who came back
    await leave(s.alice, callId);
    for (const name of NAMES.slice(1, 6)) await leave(s[name], callId);
  });
});
