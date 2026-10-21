import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { auth, closeAll, connectUsers, registerUser, resetDatabase, startServer, storedFileExists, waitFor } from './helpers.js';

let server;
let request;
let alice;
let bob;

// Smallest valid image headers; the server identifies files by these bytes.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice Profile' });
  bob = await registerUser(request, { name: 'Bob Profile' });
  await connectUsers(request, alice, bob);
});

after(async () => {
  await server.close();
  await closeAll();
});

describe('profile', () => {
  test('returns my own profile with the new fields', async () => {
    const res = await request.get('/api/profile').set(auth(alice.token)).expect(200);
    assert.deepEqual(
      { name: res.body.user.name, about: res.body.user.about, status: res.body.user.status, avatarUrl: res.body.user.avatarUrl },
      { name: 'Alice Profile', about: null, status: 'available', avatarUrl: null },
    );
  });

  test('updates name, about and status, and pushes the change to contacts live', async () => {
    const bobSocket = await server.connect(bob.token);
    const update = waitFor(bobSocket, 'user:updated', (u) => u.id === alice.user.id);

    const res = await request
      .patch('/api/profile')
      .set(auth(alice.token))
      .send({ name: '  Alice  New ', about: 'Hey there! <b>hi</b>', status: 'busy' })
      .expect(200);
    assert.equal(res.body.user.name, 'Alice  New');
    assert.equal(res.body.user.about, 'Hey there! <b>hi</b>'); // stored as text; React escapes it
    assert.equal(res.body.user.status, 'busy');

    const pushed = await update;
    assert.equal(pushed.status, 'busy');
    assert.equal(pushed.email, undefined, 'live updates do not carry the email');

    const seenByBob = await request.get(`/api/users/${alice.user.id}`).set(auth(bob.token)).expect(200);
    assert.equal(seenByBob.body.user.about, 'Hey there! <b>hi</b>');
  });

  test('validates profile fields', async () => {
    await request.patch('/api/profile').set(auth(alice.token)).send({}).expect(422);
    await request.patch('/api/profile').set(auth(alice.token)).send({ status: 'sleeping' }).expect(422);
    await request.patch('/api/profile').set(auth(alice.token)).send({ about: 'x'.repeat(141) }).expect(422);
    await request.patch('/api/profile').set(auth(alice.token)).send({ name: 'A' }).expect(422);
    // An empty about clears it.
    const res = await request.patch('/api/profile').set(auth(alice.token)).send({ about: '   ' }).expect(200);
    assert.equal(res.body.user.about, null);
  });

  test('requires authentication', async () => {
    await request.get('/api/profile').expect(401);
    await request.patch('/api/profile').send({ about: 'x' }).expect(401);
    await request.put('/api/profile/avatar').attach('avatar', PNG, 'a.png').expect(401);
  });
});

describe('profile photo', () => {
  test('uploads an image under a random name, serves it safely and replaces the old file', async () => {
    const first = await request.put('/api/profile/avatar').set(auth(alice.token)).attach('avatar', PNG, 'me.png').expect(200);
    const firstUrl = first.body.user.avatarUrl;
    assert.match(firstUrl, /^\/uploads\/avatars\/[a-f0-9]{32}\.png$/);

    const served = await request.get(firstUrl).expect(200);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.equal(served.headers['x-content-type-options'], 'nosniff');
    assert.match(served.headers['content-security-policy'], /sandbox/);

    const second = await request.put('/api/profile/avatar').set(auth(alice.token)).attach('avatar', JPG, 'me.jpg').expect(200);
    assert.match(second.body.user.avatarUrl, /\.jpg$/);
    assert.equal(await storedFileExists(`avatars/${path.basename(firstUrl)}`), false, 'old photo was deleted');
    await request.get(firstUrl).expect(404);
  });

  test('rejects non-images even when they claim to be images', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const res = await request
      .put('/api/profile/avatar')
      .set(auth(alice.token))
      .attach('avatar', html, { filename: 'evil.png', contentType: 'image/png' })
      .expect(415);
    assert.equal(res.body.error.code, 'UNSUPPORTED_FILE');

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await request.put('/api/profile/avatar').set(auth(alice.token)).attach('avatar', svg, 'x.svg').expect(415);
  });

  test('rejects files over 2 MB and missing files', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 1)]);
    const res = await request.put('/api/profile/avatar').set(auth(alice.token)).attach('avatar', big, 'big.png').expect(413);
    assert.equal(res.body.error.code, 'FILE_TOO_LARGE');
    await request.put('/api/profile/avatar').set(auth(alice.token)).expect(400);
  });

  test('removing the photo deletes the file', async () => {
    const { body } = await request.get('/api/profile').set(auth(alice.token)).expect(200);
    const res = await request.delete('/api/profile/avatar').set(auth(alice.token)).expect(200);
    assert.equal(res.body.user.avatarUrl, null);
    await request.get(body.user.avatarUrl).expect(404);
  });

  test('the uploads folder cannot be traversed', async () => {
    await request.get('/uploads/avatars/../../package.json').expect(404);
    await request.get('/uploads/avatars/%2e%2e%2f%2e%2e%2fpackage.json').expect(404);
  });
});

describe('public profiles', () => {
  test('unknown and unverified users are not found', async () => {
    await request.get('/api/users/999999').set(auth(alice.token)).expect(404);
    await request.post('/api/auth/register').send({ name: 'Unverified', email: 'unv@example.com', password: 'password123' }).expect(201);
    const search = await request.get('/api/users/search?q=unverified').set(auth(alice.token)).expect(200);
    assert.equal(search.body.users.length, 0);
  });
});
