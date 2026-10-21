import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { auth, closeAll, connectUsers, emitAck, pool, registerUser, resetDatabase, startServer, waitFor } from './helpers.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(512, 7)]);

let server;
let request;
let config;
let alice;
let bob;
let carol; // a stranger to everyone at first
let dan;
let erin;

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  ({ config } = await import('../src/config/index.js'));
  alice = await registerUser(request, { name: 'Alice Private', email: 'alice.p@example.com' });
  bob = await registerUser(request, { name: 'Bob Private', email: 'bob.p@example.com' });
  carol = await registerUser(request, { name: 'Carol Stranger', email: 'carol.s@example.com' });
  dan = await registerUser(request, { name: 'Dan Watcher', email: 'dan.w@example.com' });
  erin = await registerUser(request, { name: 'Erin Hidden', email: 'erin.h@example.com' });
});

after(async () => {
  await server.close();
  await closeAll();
});

const search = async (user, q) => (await request.get(`/api/users/search?q=${encodeURIComponent(q)}`).set(auth(user.token)).expect(200)).body.users;
const contacts = async (user) => (await request.get('/api/contacts').set(auth(user.token)).expect(200)).body.contacts;
const addContact = (user, target) => request.post('/api/contacts').set(auth(user.token)).send({ userId: target.user.id });
const setLastSeen = (user, lastSeen) => request.patch('/api/settings').set(auth(user.token)).send({ privacy: { lastSeen } }).expect(200);

describe('emails are private', () => {
  test('only people who saved me see my email', async () => {
    assert.equal((await search(alice, 'Bob Private'))[0].email, null);
    await addContact(bob, alice).expect(201); // Bob saves Alice → Alice may see Bob's email
    assert.equal((await search(alice, 'Bob Private'))[0].email, 'bob.p@example.com');
    // Alice saving Carol doesn't reveal Carol's email to Alice.
    await addContact(alice, carol).expect(201);
    assert.equal((await contacts(alice)).find((c) => c.id === carol.user.id).email, null);
  });

  test('profiles of strangers cannot be fetched by id (no counting through users)', async () => {
    await request.get(`/api/users/${erin.user.id}`).set(auth(carol.token)).expect(404);
    const connected = await request.get(`/api/users/${carol.user.id}`).set(auth(alice.token)).expect(200);
    assert.equal(connected.body.user.name, 'Carol Stranger');
    await request.get(`/api/users/${alice.user.id}`).set(auth(carol.token)).expect(200); // Alice saved Carol
  });

  test('group members do not see each other\'s emails unless saved', async () => {
    await addContact(alice, dan).expect(201);
    const group = await request
      .post('/api/groups')
      .set(auth(alice.token))
      .send({ name: 'Privacy club', memberIds: [carol.user.id, dan.user.id] })
      .expect(201);
    const info = (await request.get(`/api/groups/${group.body.conversation.id}`).set(auth(carol.token)).expect(200)).body.group;
    const emails = Object.fromEntries(info.members.map((m) => [m.name, m.email]));
    assert.equal(emails['Carol Stranger'], 'carol.s@example.com'); // my own
    assert.equal(emails['Alice Private'], 'alice.p@example.com'); // Alice saved Carol earlier
    assert.equal(emails['Dan Watcher'], null); // Dan didn't
  });
});

describe('"last seen & online" setting', () => {
  test('everyone → contacts → nobody, over REST and live', async () => {
    await addContact(dan, erin).expect(201); // Dan saved Erin; Erin did not save Dan
    const erinSocket = await server.connect(erin.token);
    const danSocket = await server.connect(dan.token);
    const erinAsSeenByDan = async () => (await contacts(dan)).find((c) => c.id === erin.user.id);

    assert.equal((await erinAsSeenByDan()).isOnline, true);

    // Only my contacts: Dan isn't one → he sees nothing, and is told live.
    const hidden = waitFor(danSocket, 'presence:update', (p) => p.userId === erin.user.id);
    const res = await setLastSeen(erin, 'contacts');
    assert.equal(res.body.settings.privacy.lastSeen, 'contacts');
    assert.deepEqual(await hidden, { userId: erin.user.id, isOnline: false, lastSeenAt: null });
    assert.deepEqual(
      (({ isOnline, lastSeenAt }) => ({ isOnline, lastSeenAt }))(await erinAsSeenByDan()),
      { isOnline: false, lastSeenAt: null },
    );

    // Erin saves Dan → he qualifies again.
    await addContact(erin, dan).expect(201);
    assert.equal((await erinAsSeenByDan()).isOnline, true);

    // Nobody: hidden from everyone, including contacts.
    const gone = waitFor(danSocket, 'presence:update', (p) => p.userId === erin.user.id && !p.isOnline);
    await setLastSeen(erin, 'nobody');
    await gone;
    assert.equal((await erinAsSeenByDan()).isOnline, false);
    // While hidden, going offline isn't announced to Dan either.
    let announced = false;
    danSocket.on('presence:update', (p) => p.userId === erin.user.id && (announced = true));
    erinSocket.disconnect();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(announced, false);

    await request.patch('/api/settings').set(auth(erin.token)).send({ privacy: { lastSeen: 'sometimes' } }).expect(422);
    await setLastSeen(erin, 'everyone');
    danSocket.disconnect();
  });
});

describe('abuse limits', () => {
  test('too many open connections for one account are refused', async () => {
    const sockets = [];
    for (let i = 0; i < config.sockets.maxPerUser; i += 1) sockets.push(await server.connect(carol.token));
    await assert.rejects(server.connect(carol.token), (error) => error.data?.code === 'TOO_MANY_CONNECTIONS');
    for (const s of sockets) s.disconnect();
  });

  test('daily upload quota', async () => {
    const conversation = await connectUsers(request, dan, bob);
    // Pretend Dan already uploaded his whole quota today.
    await pool.execute(
      `INSERT INTO attachments (uploader_id, conversation_id, kind, mime_type, original_name, size_bytes, storage_key)
       VALUES (?, ?, 'file', 'application/octet-stream', 'big.bin', ?, ?)`,
      [dan.user.id, conversation.id, config.uploads.dailyQuotaBytes, crypto.randomBytes(16).toString('hex')],
    );
    const res = await request
      .post('/api/attachments')
      .set(auth(dan.token))
      .field('conversationId', String(conversation.id))
      .attach('file', PNG, 'photo.png')
      .expect(413);
    assert.equal(res.body.error.code, 'UPLOAD_QUOTA_EXCEEDED');
    // Others are unaffected.
    await request.post('/api/attachments').set(auth(bob.token)).field('conversationId', String(conversation.id)).attach('file', PNG, 'p.png').expect(201);
  });

  test('push subscriptions only for real push services', async () => {
    const keys = webpush.generateVAPIDKeys();
    Object.assign(config.push, { publicKey: keys.publicKey, privateKey: keys.privateKey });
    const subscribe = (endpoint) =>
      request.post('/api/push/subscriptions').set(auth(bob.token)).send({ endpoint, keys: { p256dh: 'BOr8kXKy1ve4CiaEdJNIzM0k_0', auth: 'c2VjcmV0c2VjcmV0' } });
    try {
      for (const endpoint of [
        'https://evil.example.com/push',
        'https://mysql.railway.internal/x',
        'https://172.16.0.5/x',
        'https://fcm.googleapis.com:8443/fcm/send/x',
        'https://fcm.googleapis.com.evil.com/x',
      ]) {
        const res = await subscribe(endpoint);
        assert.ok([400, 422].includes(res.status), `${endpoint} → ${res.status}`);
      }
      await subscribe('https://fcm.googleapis.com/fcm/send/ok-1').expect(201);
      await subscribe('https://updates.push.services.mozilla.com/wpush/v2/ok').expect(201);
    } finally {
      Object.assign(config.push, { publicKey: '', privateKey: '' });
    }
  });
});

describe('production safety (configuration)', () => {
  const loadConfig = (env) =>
    JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', "const { config } = await import('./src/config/index.js'); console.log(JSON.stringify({ env: config.env, dev: config.otp.devDisplay }))"], {
        cwd: serverRoot,
        env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: '', DB_NAME: 'x', JWT_ACCESS_SECRET: 'x'.repeat(40), ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );

  test('codes are shown only when explicitly enabled in local development', () => {
    // Tests load the real .env too; NODE_ENV=test stops that, so set what we need explicitly.
    assert.deepEqual(loadConfig({ NODE_ENV: 'test', OTP_DEV_DISPLAY: 'true' }), { env: 'test', dev: true });
    assert.deepEqual(loadConfig({ NODE_ENV: 'test' }), { env: 'test', dev: false });
    assert.deepEqual(loadConfig({ NODE_ENV: 'production', OTP_DEV_DISPLAY: 'true' }), { env: 'production', dev: false });
    // NODE_ENV forgotten on Railway → still production, never shows codes.
    assert.deepEqual(loadConfig({ NODE_ENV: '', RAILWAY_ENVIRONMENT_NAME: 'production', OTP_DEV_DISPLAY: 'true', JWT_ACCESS_SECRET: 'y'.repeat(40) }).dev, false);
  });

  test('the example JWT secret is refused', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'test', JWT_ACCESS_SECRET: 'change-me-to-a-long-random-string-of-at-least-32-chars' }), /example value/);
  });
});

describe('my data', () => {
  test('download my data', async () => {
    const conversation = await connectUsers(request, alice, erin);
    await request.post(`/api/conversations/${conversation.id}/messages`).set(auth(alice.token)).send({ body: 'export me' }).expect(201);
    const res = await request.get('/api/profile/export').set(auth(alice.token)).expect(200);
    assert.match(res.headers['content-disposition'], /attachment; filename="temu-my-data-/);
    assert.equal(res.body.account.email, 'alice.p@example.com');
    assert.ok(res.body.messagesSent.some((m) => m.text === 'export me'));
    assert.ok(res.body.loginSessions.length >= 1);
    assert.ok(res.body.contacts.some((c) => c.name === 'Carol Stranger'));
    await request.get('/api/profile/export').expect(401);
  });

  test('delete my account: password required; chats, groups and sign-in are cleaned up', async () => {
    const victim = await registerUser(request, { name: 'Vic Leaving', email: 'vic@example.com' });
    const direct = await connectUsers(request, victim, bob);
    await request.post(`/api/conversations/${direct.id}/messages`).set(auth(victim.token)).send({ body: 'bye' }).expect(201);
    await addContact(victim, carol).expect(201);
    const group = (
      await request.post('/api/groups').set(auth(victim.token)).send({ name: 'Vic group', memberIds: [bob.user.id, carol.user.id] }).expect(201)
    ).body.conversation;

    const bobSocket = await server.connect(bob.token);
    const victimSocket = await server.connect(victim.token);
    const removed = waitFor(bobSocket, 'conversation:removed', (e) => e.conversationId === direct.id);
    const deletedNote = waitFor(bobSocket, 'user:deleted', (e) => e.userId === victim.user.id);
    const signedOut = waitFor(victimSocket, 'auth:revoked');

    const wrong = await request.post('/api/profile/delete').set(auth(victim.token)).send({ password: 'not-my-password1' }).expect(403);
    assert.equal(wrong.body.error.code, 'WRONG_PASSWORD');
    await request.post('/api/profile/delete').set(auth(victim.token)).send({}).expect(422);

    await request.post('/api/profile/delete').set(auth(victim.token)).send({ password: victim.password }).expect(204);
    await Promise.all([removed, deletedNote, signedOut]);

    // Gone everywhere.
    await request.post('/api/auth/login').send({ email: 'vic@example.com', password: victim.password }).expect(401);
    await request.get('/api/profile').set(auth(victim.token)).expect(401);
    await request.get(`/api/conversations/${direct.id}`).set(auth(bob.token)).expect(404);
    assert.equal((await search(bob, 'Vic Leaving')).length, 0);
    // The group lives on with a new owner.
    const info = (await request.get(`/api/groups/${group.id}`).set(auth(bob.token)).expect(200)).body.group;
    assert.deepEqual(info.members.map((m) => [m.name, m.role]).sort(), [['Bob Private', 'owner'], ['Carol Stranger', 'member']]);
    const [[left]] = await pool.query('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ?', [victim.user.id]);
    assert.equal(left.n, 0);
    bobSocket.disconnect();
  });
});
