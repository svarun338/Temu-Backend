import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auth, closeAll, connectUsers, emitAck, expectNoEvent, registerUser, resetDatabase, startServer, waitFor } from './helpers.js';

let server;
let request;
let alice;
let bob;
let carol;
let dave;
let aliceBob; // conversation
let carolBob;
let aliceDave;

const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' };
const tab = (name) => `${name}-tab-0123456789`;
const connect = (user, tabId) => server.connect(user.token, { auth: { token: user.token, tabId } });
const isCallNote = (status) => (m) => m.event?.type === 'call' && m.event.data.status === status;
const calls = async (user) => (await request.get('/api/calls').set(auth(user.token)).expect(200)).body.calls;

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice Caller' });
  bob = await registerUser(request, { name: 'Bob Callee' });
  carol = await registerUser(request, { name: 'Carol Third' });
  dave = await registerUser(request, { name: 'Dave Fourth' });
  aliceBob = await connectUsers(request, alice, bob);
  carolBob = await connectUsers(request, carol, bob);
  aliceDave = await connectUsers(request, alice, dave);
});

after(async () => {
  await server.close();
  await closeAll();
});

/** Alice calls Bob and Bob answers on `bobTab`. */
async function connectedCall(type = 'voice') {
  const a = await connect(alice, tab('alice'));
  const b = await connect(bob, tab('bob'));
  const ringing = waitFor(b, 'call:incoming');
  const started = await emitAck(a, 'call:start', { conversationId: aliceBob.id, type });
  assert.equal(started.ok, true, JSON.stringify(started.error));
  const { call } = await ringing;
  const accepted = waitFor(a, 'call:accepted');
  assert.equal((await emitAck(b, 'call:accept', { callId: call.id })).ok, true);
  await accepted;
  return { a, b, call };
}

describe('placing a call', () => {
  test('rings the other person with who is calling, and gives ICE servers', async () => {
    const a = await connect(alice, tab('alice'));
    const b = await connect(bob, tab('bob'));
    const ringing = waitFor(b, 'call:incoming');
    const res = await emitAck(a, 'call:start', { conversationId: aliceBob.id, type: 'video' });
    assert.equal(res.ok, true);
    assert.equal(res.data.call.status, 'ringing');
    assert.equal(res.data.call.type, 'video');
    assert.equal(res.data.iceServers[0].urls[0], 'stun:stun.example.test:3478');
    // TURN credentials are short-lived and tied to the user.
    assert.match(res.data.iceServers[1].username, new RegExp(`^\\d+:${alice.user.id}$`));
    assert.ok(res.data.iceServers[1].credential);

    const incoming = await ringing;
    assert.equal(incoming.call.id, res.data.call.id);
    assert.equal(incoming.call.caller.name, 'Alice Caller');
    assert.equal(incoming.call.conversationId, aliceBob.id);

    const ended = waitFor(b, 'call:ended');
    await emitAck(a, 'call:end', { callId: res.data.call.id });
    assert.equal((await ended).status, 'missed'); // cancelled before Bob answered
    a.disconnect();
    b.disconnect();
  });

  test('a callee who comes online while it is still ringing gets the call', async () => {
    const a = await connect(alice, tab('alice'));
    const res = await emitAck(a, 'call:start', { conversationId: aliceBob.id, type: 'voice' });
    // Sent right after the connection is set up, so listen before it is ready.
    let incoming;
    const b = await server.connect(bob.token, { auth: { token: bob.token, tabId: tab('bob') }, onSocket: (s) => (incoming = waitFor(s, 'call:incoming')) });
    incoming = await incoming;
    assert.equal(incoming.call.id, res.data.call.id);
    const ended = waitFor(b, 'call:ended');
    await emitAck(a, 'call:end', { callId: res.data.call.id });
    await ended;
    a.disconnect();
    b.disconnect();
  });

  test('only one-to-one chats, not across a block, and not while already in a call', async () => {
    const a = await connect(alice, tab('alice'));
    await request.post('/api/contacts').set(auth(alice.token)).send({ userId: carol.user.id }).expect(201);
    const group = await request.post('/api/groups').set(auth(alice.token)).send({ name: 'Team', memberIds: [bob.user.id, carol.user.id] }).expect(201);
    const inGroup = await emitAck(a, 'call:start', { conversationId: group.body.conversation.id, type: 'voice' });
    assert.equal(inGroup.ok, false);
    assert.match(inGroup.error.message, /one-to-one/);

    // Not a participant: 404, so outsiders can't probe chats.
    const c = await connect(carol, tab('carol'));
    const foreign = await emitAck(c, 'call:start', { conversationId: aliceBob.id, type: 'voice' });
    assert.equal(foreign.error.code, 'NOT_FOUND');

    await request.post('/api/blocks').set(auth(dave.token)).send({ userId: alice.user.id }).expect(201);
    const blocked = await emitAck(a, 'call:start', { conversationId: aliceDave.id, type: 'voice' });
    assert.equal(blocked.error.code, 'CANNOT_CALL');
    await request.delete(`/api/blocks/${alice.user.id}`).set(auth(dave.token)).expect(204);

    const first = await emitAck(a, 'call:start', { conversationId: aliceBob.id, type: 'voice' });
    const second = await emitAck(a, 'call:start', { conversationId: aliceDave.id, type: 'voice' });
    assert.equal(second.error.code, 'ALREADY_IN_CALL');
    await emitAck(a, 'call:end', { callId: first.data.call.id });

    const bad = await emitAck(a, 'call:start', { conversationId: aliceBob.id, type: 'screen' });
    assert.equal(bad.error.code, 'VALIDATION_ERROR');
    a.disconnect();
    c.disconnect();
  });

  test('calling someone who is in another call logs "busy" without ringing', async () => {
    const { a, b, call } = await connectedCall();
    const c = await connect(carol, tab('carol'));
    const noRing = expectNoEvent(b, 'call:incoming');
    const res = await emitAck(c, 'call:start', { conversationId: carolBob.id, type: 'voice' });
    assert.equal(res.ok, true);
    assert.equal(res.data.call.status, 'busy');
    await noRing;
    const ended = waitFor(b, 'call:ended');
    await emitAck(a, 'call:end', { callId: call.id });
    await ended;
    assert.equal((await calls(carol))[0].status, 'busy');
    for (const s of [a, b, c]) s.disconnect();
  });
});

describe('answering', () => {
  test('answering on one tab stops the others ringing; signals reach only the answering tab', async () => {
    const a = await connect(alice, tab('alice'));
    const b1 = await connect(bob, tab('bob-one'));
    const b2 = await connect(bob, tab('bob-two'));
    const rings = [waitFor(b1, 'call:incoming'), waitFor(b2, 'call:incoming')];
    const { data } = await emitAck(a, 'call:start', { conversationId: aliceBob.id, type: 'video' });
    await Promise.all(rings);

    // Signalling before the call is answered is refused.
    const early = await emitAck(a, 'call:signal', { callId: data.call.id, data: OFFER });
    assert.equal(early.error.code, 'CALL_NOT_CONNECTED');

    const handled = waitFor(b2, 'call:handled');
    const accepted = waitFor(a, 'call:accepted');
    const res = await emitAck(b1, 'call:accept', { callId: data.call.id });
    assert.equal(res.data.call.status, 'ongoing');
    assert.equal((await handled).callId, data.call.id);
    await accepted;

    // A second answer (other tab) is refused.
    assert.equal((await emitAck(b2, 'call:accept', { callId: data.call.id })).error.code, 'CALL_ANSWERED');

    const offerArrives = waitFor(b1, 'call:signal');
    const notOtherTab = expectNoEvent(b2, 'call:signal');
    assert.equal((await emitAck(a, 'call:signal', { callId: data.call.id, data: OFFER })).ok, true);
    assert.deepEqual((await offerArrives).data, OFFER);
    await notOtherTab;

    const answerArrives = waitFor(a, 'call:signal');
    await emitAck(b1, 'call:signal', { callId: data.call.id, data: { type: 'answer', sdp: 'v=0' } });
    assert.equal((await answerArrives).data.type, 'answer');

    const candidate = { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } };
    const candidateArrives = waitFor(b1, 'call:signal');
    await emitAck(a, 'call:signal', { callId: data.call.id, data: candidate });
    assert.deepEqual((await candidateArrives).data, candidate);

    const stateArrives = waitFor(a, 'call:signal');
    await emitAck(b1, 'call:signal', { callId: data.call.id, data: { type: 'state', audio: false, video: true } });
    assert.deepEqual((await stateArrives).data, { type: 'state', audio: false, video: true });
    const screenArrives = waitFor(a, 'call:signal');
    await emitAck(b1, 'call:signal', { callId: data.call.id, data: { type: 'state', audio: true, video: false, screen: true } });
    assert.deepEqual((await screenArrives).data, { type: 'state', audio: true, video: false, screen: true });

    // The non-answering tab can't inject signals; nor can outsiders.
    assert.equal((await emitAck(b2, 'call:signal', { callId: data.call.id, data: OFFER })).error.code, 'NOT_FOUND');
    const c = await connect(carol, tab('carol'));
    assert.equal((await emitAck(c, 'call:signal', { callId: data.call.id, data: OFFER })).error.code, 'NOT_FOUND');
    assert.equal((await emitAck(c, 'call:end', { callId: data.call.id })).ok, true); // no-op
    assert.equal((await emitAck(a, 'call:signal', { callId: data.call.id, data: { type: 'script', x: 1 } })).error.code, 'VALIDATION_ERROR');

    const note = waitFor(a, 'message:new', isCallNote('ended'));
    const ended = waitFor(a, 'call:ended');
    await emitAck(b1, 'call:end', { callId: data.call.id });
    assert.deepEqual(await ended, { callId: data.call.id, status: 'ended', endedBy: bob.user.id });
    const message = await note;
    assert.equal(message.senderId, alice.user.id);
    assert.equal(message.event.data.type, 'video');
    for (const s of [a, b1, b2, c]) s.disconnect();
  });

  test('declining ends the call for the caller', async () => {
    const a = await connect(alice, tab('alice'));
    const b = await connect(bob, tab('bob'));
    const ringing = waitFor(b, 'call:incoming');
    const { data } = await emitAck(a, 'call:start', { conversationId: aliceBob.id, type: 'voice' });
    await ringing;
    // The caller can't "decline" their own call.
    assert.equal((await emitAck(a, 'call:reject', { callId: data.call.id })).ok, false);
    const ended = waitFor(a, 'call:ended');
    await emitAck(b, 'call:reject', { callId: data.call.id });
    assert.equal((await ended).status, 'rejected');
    a.disconnect();
    b.disconnect();
  });

  test('an unanswered call times out as missed and counts as unread for the callee', async () => {
    const a = await connect(alice, tab('alice'));
    const before = (await request.get(`/api/conversations/${aliceBob.id}`).set(auth(bob.token)).expect(200)).body.conversation.unreadCount;
    const note = waitFor(a, 'message:new', isCallNote('missed'), 3000);
    const ended = waitFor(a, 'call:ended', () => true, 3000);
    await emitAck(a, 'call:start', { conversationId: aliceBob.id, type: 'voice' });
    assert.equal((await ended).status, 'missed');
    await note;
    const after = (await request.get(`/api/conversations/${aliceBob.id}`).set(auth(bob.token)).expect(200)).body.conversation;
    assert.equal(after.unreadCount, before + 1);
    assert.equal(after.lastMessage.event.type, 'call');
    a.disconnect();
  });
});

describe('connection drops', () => {
  test('a call survives its tab reconnecting (token refresh), and ends if the tab never comes back', async () => {
    const { a, b, call } = await connectedCall();
    a.disconnect();
    const back = await connect(alice, tab('alice'));
    await new Promise((resolve) => setTimeout(resolve, 1300)); // longer than the 1 s grace period
    const arrives = waitFor(b, 'call:signal');
    assert.equal((await emitAck(back, 'call:signal', { callId: call.id, data: OFFER })).ok, true);
    await arrives;

    const ended = waitFor(back, 'call:ended', () => true, 3000);
    b.disconnect();
    assert.deepEqual(await ended, { callId: call.id, status: 'ended', endedBy: bob.user.id });
    back.disconnect();
  });
});

describe('call history', () => {
  test('lists my calls with direction, status and duration; hiding is per person', async () => {
    const history = await calls(alice);
    assert.ok(history.length >= 5);
    assert.ok(history.every((c) => c.direction === 'outgoing' && c.peer.name === 'Bob Callee'));
    assert.ok(history.some((c) => c.status === 'ended' && c.answeredAt && c.durationSec >= 0));
    const bobs = await calls(bob);
    assert.ok(bobs.some((c) => c.direction === 'incoming' && c.status === 'missed'));
    assert.ok(bobs.some((c) => c.status === 'busy' && c.peer.name === 'Carol Third'));

    await request.post('/api/calls/hide').set(auth(alice.token)).send({ callIds: [history[0].id] }).expect(204);
    assert.equal((await calls(alice)).length, history.length - 1);
    assert.equal((await calls(bob)).length, bobs.length); // Bob still sees it
    // Hiding someone else's call does nothing.
    await request.post('/api/calls/hide').set(auth(dave.token)).send({ callIds: [history[1].id] }).expect(204);
    assert.equal((await calls(alice)).length, history.length - 1);

    await request.post('/api/calls/hide').set(auth(alice.token)).send({ all: true }).expect(204);
    assert.equal((await calls(alice)).length, 0);
    await request.post('/api/calls/hide').set(auth(alice.token)).send({}).expect(422);
    await request.get('/api/calls').expect(401);
  });

  test('ICE servers endpoint', async () => {
    const res = await request.get('/api/calls/ice-servers').set(auth(bob.token)).expect(200);
    assert.equal(res.body.iceServers.length, 2);
  });
});
