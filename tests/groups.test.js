import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auth, closeAll, emitAck, expectNoEvent, pool, registerUser, resetDatabase, startServer, waitFor } from './helpers.js';

let server;
let request;
let owner; // Olivia, creates the group
let ann;
let ben;
let cat; // not in the group at first
let stranger; // not a contact of anyone

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

async function befriend(a, b) {
  await request.post('/api/contacts').set(auth(a.token)).send({ userId: b.user.id }).expect(201);
}

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  owner = await registerUser(request, { name: 'Olivia Owner' });
  ann = await registerUser(request, { name: 'Ann Member' });
  ben = await registerUser(request, { name: 'Ben Member' });
  cat = await registerUser(request, { name: 'Cat Later' });
  stranger = await registerUser(request, { name: 'Stan Stranger' });
  for (const user of [ann, ben, cat]) await befriend(owner, user);
});

after(async () => {
  await server.close();
  await closeAll();
});

const createGroup = (user, body) => request.post('/api/groups').set(auth(user.token)).send(body);
const info = async (user, id) => (await request.get(`/api/groups/${id}`).set(auth(user.token)).expect(200)).body.group;
const send = (user, id, body) => request.post(`/api/conversations/${id}/messages`).set(auth(user.token)).send({ body });
const history = async (user, id) => (await request.get(`/api/conversations/${id}/messages?limit=100`).set(auth(user.token)).expect(200)).body.messages;

describe('creating a group', () => {
  test('creates the group with the creator as owner and system messages', async () => {
    const annSocket = await server.connect(ann.token);
    const arrived = waitFor(annSocket, 'message:new', (m) => m.event?.type === 'members_added');
    const res = await createGroup(owner, { name: '  Weekend trip ', description: 'Plans', memberIds: [ann.user.id, ben.user.id] }).expect(201);
    const { conversation } = res.body;
    assert.equal(conversation.type, 'group');
    assert.equal(conversation.peer, null);
    assert.deepEqual(
      { name: conversation.group.name, members: conversation.group.memberCount, role: conversation.group.myRole },
      { name: 'Weekend trip', members: 3, role: 'owner' },
    );
    const event = await arrived;
    assert.deepEqual(event.event.data.users.map((u) => u.name).sort(), ['Ann Member', 'Ben Member']);
    annSocket.disconnect();

    const group = await info(ann, conversation.id);
    assert.deepEqual(group.members.map((m) => [m.name, m.role]), [['Olivia Owner', 'owner'], ['Ann Member', 'member'], ['Ben Member', 'member']]);
    assert.equal(group.inviteCode, null);
  });

  test('only your contacts can be added, and the group needs members', async () => {
    await createGroup(owner, { name: 'X', memberIds: [stranger.user.id] }).expect(400);
    await createGroup(owner, { name: 'X', memberIds: [] }).expect(422);
    await createGroup(owner, { name: '', memberIds: [ann.user.id] }).expect(422);
  });
});

describe('messaging in a group', () => {
  let groupId;
  before(async () => {
    groupId = (await createGroup(owner, { name: 'Chat', memberIds: [ann.user.id, ben.user.id] }).expect(201)).body.conversation.id;
  });

  test('every member receives messages live, with the sender name', async () => {
    const annSocket = await server.connect(ann.token);
    const benSocket = await server.connect(ben.token);
    const toAnn = waitFor(annSocket, 'message:new', (m) => m.body === 'Hello all');
    const toBen = waitFor(benSocket, 'message:new', (m) => m.body === 'Hello all');
    await send(owner, groupId, 'Hello all').expect(201);
    assert.equal((await toAnn).senderName, 'Olivia Owner');
    await toBen;
    annSocket.disconnect();
    benSocket.disconnect();
  });

  test('ticks turn "read" only when every member has read', async () => {
    const message = (await send(owner, groupId, 'Read me').expect(201)).body.message;
    const ownerSocket = await server.connect(owner.token);

    await request.post(`/api/conversations/${groupId}/read`).set(auth(ann.token)).send({}).expect(200);
    const afterAnn = (await history(owner, groupId)).find((m) => m.id === message.id);
    assert.notEqual(afterAnn.status, 'read', 'Ben has not read it yet');

    const allRead = waitFor(ownerSocket, 'message:status', (r) => r.status === 'read' && r.upToMessageId >= message.id);
    await request.post(`/api/conversations/${groupId}/read`).set(auth(ben.token)).send({}).expect(200);
    await allRead;
    assert.equal((await history(owner, groupId)).find((m) => m.id === message.id).status, 'read');
    ownerSocket.disconnect();
  });

  test('unread counts follow each member’s own reading', async () => {
    await send(owner, groupId, 'one').expect(201);
    await send(owner, groupId, 'two').expect(201);
    const benList = (await request.get('/api/conversations').set(auth(ben.token))).body.conversations;
    assert.equal(benList.find((c) => c.id === groupId).unreadCount, 2);
    await request.post(`/api/conversations/${groupId}/read`).set(auth(ben.token)).send({}).expect(200);
    const after = (await request.get('/api/conversations').set(auth(ben.token))).body.conversations;
    assert.equal(after.find((c) => c.id === groupId).unreadCount, 0);
  });

  test('typing is relayed to the whole group', async () => {
    const annSocket = await server.connect(ann.token);
    const benSocket = await server.connect(ben.token);
    const seen = waitFor(benSocket, 'typing', (t) => t.userId === ann.user.id && t.isTyping);
    await emitAck(annSocket, 'typing:start', { conversationId: groupId });
    await seen;
    annSocket.disconnect();
    benSocket.disconnect();
  });

  test('outsiders cannot read or post, and system messages cannot be edited or reacted to', async () => {
    await request.get(`/api/conversations/${groupId}/messages`).set(auth(cat.token)).expect(404);
    await send(cat, groupId, 'let me in').expect(404);
    await request.get(`/api/groups/${groupId}`).set(auth(cat.token)).expect(404);

    const system = (await history(owner, groupId)).find((m) => m.event);
    await request.patch(`/api/messages/${system.id}`).set(auth(owner.token)).send({ body: 'changed' }).expect(400);
    await request.put(`/api/messages/${system.id}/reaction`).set(auth(ann.token)).send({ emoji: '👍' }).expect(400);
  });
});

describe('managing a group', () => {
  let groupId;
  before(async () => {
    groupId = (await createGroup(owner, { name: 'Team', memberIds: [ann.user.id, ben.user.id] }).expect(201)).body.conversation.id;
  });

  test('editing info follows the permission; settings are admin-only', async () => {
    // Default: only admins edit info.
    await request.patch(`/api/groups/${groupId}`).set(auth(ann.token)).send({ name: 'Ann was here' }).expect(403);
    await request.patch(`/api/groups/${groupId}`).set(auth(ann.token)).send({ editPermission: 'all' }).expect(403);

    await request.patch(`/api/groups/${groupId}`).set(auth(owner.token)).send({ editPermission: 'all' }).expect(200);
    const res = await request.patch(`/api/groups/${groupId}`).set(auth(ann.token)).send({ name: 'Team ✨', description: 'Our team' }).expect(200);
    assert.equal(res.body.group.name, 'Team ✨');
    assert.ok((await history(ben, groupId)).some((m) => m.event?.type === 'group_renamed' && m.event.data.name === 'Team ✨'));
  });

  test('"only admins can send" blocks members until they are made admin', async () => {
    await request.patch(`/api/groups/${groupId}`).set(auth(owner.token)).send({ sendPermission: 'admins' }).expect(200);
    const blocked = await send(ann, groupId, 'can I talk?').expect(403);
    assert.equal(blocked.body.error.code, 'ADMINS_ONLY');

    await request.patch(`/api/groups/${groupId}/members/${ann.user.id}`).set(auth(owner.token)).send({ role: 'admin' }).expect(200);
    await send(ann, groupId, 'now I can').expect(201);
    await request.patch(`/api/groups/${groupId}`).set(auth(owner.token)).send({ sendPermission: 'all' }).expect(200);
  });

  test('admins add and remove members; members cannot', async () => {
    await request.post(`/api/groups/${groupId}/members`).set(auth(ben.token)).send({ userIds: [cat.user.id] }).expect(403);

    const catSocket = await server.connect(cat.token);
    const added = waitFor(catSocket, 'message:new', (m) => m.event?.type === 'members_added' && m.conversationId === groupId);
    await request.post(`/api/groups/${groupId}/members`).set(auth(owner.token)).send({ userIds: [cat.user.id] }).expect(200);
    await added;
    // New members don't inherit a backlog of unread messages.
    const catList = (await request.get('/api/conversations').set(auth(cat.token))).body.conversations;
    assert.equal(catList.find((c) => c.id === groupId).unreadCount, 0);

    const removed = waitFor(catSocket, 'group:removed', (e) => e.conversationId === groupId);
    await request.delete(`/api/groups/${groupId}/members/${cat.user.id}`).set(auth(ann.token)).expect(200); // Ann is an admin now
    await removed;
    await request.get(`/api/conversations/${groupId}/messages`).set(auth(cat.token)).expect(404);

    // Cat's socket left the room: later messages don't reach her.
    const silent = expectNoEvent(catSocket, 'message:new', 300);
    await send(owner, groupId, 'after Cat left').expect(201);
    await silent;
    catSocket.disconnect();
  });

  test('the owner is protected; only the owner removes admins', async () => {
    await request.delete(`/api/groups/${groupId}/members/${owner.user.id}`).set(auth(ann.token)).expect(403);
    await request.patch(`/api/groups/${groupId}/members/${owner.user.id}`).set(auth(ann.token)).send({ role: 'member' }).expect(403);
    await request.patch(`/api/groups/${groupId}/members/${ben.user.id}`).set(auth(owner.token)).send({ role: 'admin' }).expect(200);
    await request.delete(`/api/groups/${groupId}/members/${ben.user.id}`).set(auth(ann.token)).expect(403); // admin vs admin
  });

  test('group photo: type-checked and respects the edit permission', async () => {
    const res = await request.put(`/api/groups/${groupId}/avatar`).set(auth(owner.token)).attach('avatar', PNG, 'g.png').expect(200);
    assert.match(res.body.group.avatarUrl, /^\/uploads\/avatars\/[a-f0-9]{32}\.png$/);
    await request.put(`/api/groups/${groupId}/avatar`).set(auth(owner.token)).attach('avatar', Buffer.from('<svg/>'), 'x.png').expect(415);
    await request.delete(`/api/groups/${groupId}/avatar`).set(auth(owner.token)).expect(200);
  });

  test('when the owner leaves, the longest-serving admin becomes owner', async () => {
    await request.post(`/api/groups/${groupId}/leave`).set(auth(owner.token)).expect(204);
    const group = await info(ann, groupId);
    assert.equal(group.members.find((m) => m.id === ann.user.id).role, 'owner');
    assert.ok(!group.members.some((m) => m.id === owner.user.id));
    assert.ok((await history(ann, groupId)).some((m) => m.event?.type === 'owner_changed'));
  });

  test('the last member leaving deletes the group', async () => {
    const solo = (await createGroup(owner, { name: 'Tiny', memberIds: [cat.user.id] }).expect(201)).body.conversation.id;
    await request.post(`/api/groups/${solo}/leave`).set(auth(cat.token)).expect(204);
    await request.post(`/api/groups/${solo}/leave`).set(auth(owner.token)).expect(204);
    const [rows] = await pool.query('SELECT 1 FROM conversations WHERE id = ?', [solo]);
    assert.equal(rows.length, 0);
  });
});

describe('invite links', () => {
  let groupId;
  before(async () => {
    groupId = (await createGroup(owner, { name: 'Open group', memberIds: [ann.user.id] }).expect(201)).body.conversation.id;
  });

  test('admins create a link; anyone signed in can preview and join; resetting kills the old link', async () => {
    await request.post(`/api/groups/${groupId}/invite`).set(auth(ann.token)).expect(403);
    const { inviteCode } = (await request.post(`/api/groups/${groupId}/invite`).set(auth(owner.token)).expect(200)).body;
    assert.match(inviteCode, /^[A-Za-z0-9_-]{22}$/);

    const preview = (await request.get(`/api/groups/invites/${inviteCode}`).set(auth(stranger.token)).expect(200)).body.invite;
    assert.deepEqual({ name: preview.name, members: preview.memberCount, member: preview.alreadyMember }, { name: 'Open group', members: 2, member: false });

    const joined = await request.post(`/api/groups/invites/${inviteCode}/join`).set(auth(stranger.token)).expect(200);
    assert.equal(joined.body.conversation.id, groupId);
    assert.ok((await history(owner, groupId)).some((m) => m.event?.type === 'joined_via_link'));

    const { inviteCode: fresh } = (await request.post(`/api/groups/${groupId}/invite`).set(auth(owner.token)).expect(200)).body;
    assert.notEqual(fresh, inviteCode);
    await request.get(`/api/groups/invites/${inviteCode}`).set(auth(cat.token)).expect(404);
    await request.delete(`/api/groups/${groupId}/invite`).set(auth(owner.token)).expect(200);
    await request.get(`/api/groups/invites/${fresh}`).set(auth(cat.token)).expect(404);
    await request.get('/api/groups/invites/not-a-code').set(auth(cat.token)).expect(422);
  });
});
