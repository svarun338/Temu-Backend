import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auth, closeAll, pool, registerUser, resetDatabase, startServer } from './helpers.js';

let server;
let request;

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
});

after(async () => {
  await server.close();
  await closeAll();
});

const XHR = { 'X-Requested-With': 'XMLHttpRequest' };

describe('registration', () => {
  test('creates an unverified account and only starts a session after the email code is confirmed', async () => {
    const reg = await request
      .post('/api/auth/register')
      .send({ name: '  Alice  ', email: 'Alice@Example.com', password: 'password123' })
      .expect(201);

    assert.equal(reg.body.requiresVerification, true);
    assert.equal(reg.body.email, 'alice@example.com');
    assert.match(reg.body.devOtp, /^\d{6}$/);
    assert.equal(reg.body.accessToken, undefined, 'no token before verification');
    assert.equal(reg.headers['set-cookie'], undefined, 'no session cookie before verification');

    const res = await request.post('/api/auth/verify-email').send({ email: 'alice@example.com', code: reg.body.devOtp }).expect(200);
    assert.equal(res.body.user.name, 'Alice');
    assert.equal(res.body.user.email, 'alice@example.com');
    assert.equal(res.body.user.emailVerified, true);
    assert.ok(res.body.accessToken);
    assert.equal(res.body.user.password_hash, undefined);

    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /temu_refresh=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/api\/auth/);

    const [rows] = await pool.query('SELECT password_hash FROM users WHERE email = ?', ['alice@example.com']);
    assert.match(rows[0].password_hash, /^\$2[aby]\$/);
    assert.notEqual(rows[0].password_hash, 'password123');
  });

  test('rejects duplicate verified emails (case-insensitive)', async () => {
    const res = await request
      .post('/api/auth/register')
      .send({ name: 'Alice 2', email: 'ALICE@example.com', password: 'password123' })
      .expect(409);
    assert.equal(res.body.error.code, 'CONFLICT');
  });

  test('validates input', async () => {
    const res = await request.post('/api/auth/register').send({ name: 'A', email: 'nope', password: 'short' }).expect(422);
    const fields = res.body.error.details.map((d) => d.field);
    assert.ok(fields.includes('name'));
    assert.ok(fields.includes('email'));
    assert.ok(fields.includes('password'));
  });

  test('ignores unknown fields such as id', async () => {
    const res = await request
      .post('/api/auth/register')
      .send({ id: 999, name: 'Mallory', email: 'mallory@example.com', password: 'password123' })
      .expect(201);
    const verified = await request
      .post('/api/auth/verify-email')
      .send({ email: 'mallory@example.com', code: res.body.devOtp })
      .expect(200);
    assert.notEqual(verified.body.user.id, 999);
  });
});

describe('login', () => {
  test('logs in with correct credentials', async () => {
    const res = await request
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'password123' })
      .expect(200);
    assert.equal(res.body.user.email, 'alice@example.com');
    assert.ok(res.body.accessToken);
  });

  test('returns the same generic error for a wrong password and an unknown email', async () => {
    const wrong = await request.post('/api/auth/login').send({ email: 'alice@example.com', password: 'wrongpass1' }).expect(401);
    const unknown = await request.post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrongpass1' }).expect(401);
    assert.equal(wrong.body.error.message, 'Invalid email or password');
    assert.deepEqual(wrong.body, unknown.body);
  });

  test('rejects malformed JSON without leaking details', async () => {
    const res = await request.post('/api/auth/login').set('Content-Type', 'application/json').send('{oops').expect(400);
    assert.equal(res.body.error.message, 'Malformed JSON body');
  });
});

describe('protected routes', () => {
  test('require a bearer token', async () => {
    await request.get('/api/auth/me').expect(401);
    await request.get('/api/contacts').expect(401);
    await request.get('/api/conversations').expect(401);
    await request.get('/api/users/search?q=al').expect(401);
  });

  test('reject forged, tampered and wrongly signed tokens', async () => {
    const { token } = await registerUser(request);
    const [header, payload, signature] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: '1', sid: 1, typ: 'access' })).toString('base64url');
    await request.get('/api/auth/me').set(auth(`${header}.${forgedPayload}.${signature}`)).expect(401);
    await request.get('/api/auth/me').set(auth('not-a-jwt')).expect(401);
    const noneAlg = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${payload}.`;
    await request.get('/api/auth/me').set(auth(noneAlg)).expect(401);
  });

  test('return the authenticated user', async () => {
    const { user, token } = await registerUser(request, { name: 'Bob' });
    const res = await request.get('/api/auth/me').set(auth(token)).expect(200);
    assert.deepEqual(res.body.user, user);
  });
});

describe('sessions', () => {
  test('refresh requires the CSRF header and a valid cookie', async () => {
    const { cookie } = await registerUser(request);
    await request.post('/api/auth/refresh').set('Cookie', cookie).expect(403);
    await request.post('/api/auth/refresh').set(XHR).expect(401);
    await request.post('/api/auth/refresh').set(XHR).set('Cookie', 'temu_refresh=garbage').expect(401);
  });

  test('refresh rotates the refresh token', async () => {
    const { cookie, user } = await registerUser(request);
    const res = await request.post('/api/auth/refresh').set(XHR).set('Cookie', cookie).expect(200);
    assert.equal(res.body.user.id, user.id);
    assert.ok(res.body.accessToken);
    const newCookie = res.headers['set-cookie'][0].split(';')[0];
    assert.notEqual(newCookie, cookie);

    // The new token works; the old one is still honoured briefly (parallel tabs) without rotating again.
    await request.post('/api/auth/refresh').set(XHR).set('Cookie', newCookie).expect(200);
    const graceRes = await request.post('/api/auth/refresh').set(XHR).set('Cookie', newCookie).expect(200);
    assert.ok(graceRes.body.accessToken);
    // Only the media cookie is refreshed; the refresh token is not rotated again.
    const setCookies = graceRes.headers['set-cookie'] ?? [];
    assert.ok(!setCookies.some((c) => c.startsWith('temu_refresh=')));
    assert.ok(setCookies.some((c) => c.startsWith('temu_media=')));
  });

  test('the media cookie is httpOnly, SameSite=Strict and limited to attachment downloads', async () => {
    const reg = await request
      .post('/api/auth/register')
      .send({ name: 'Media Cookie', email: 'media-cookie@example.com', password: 'password123' })
      .expect(201);
    const res = await request.post('/api/auth/verify-email').send({ email: 'media-cookie@example.com', code: reg.body.devOtp }).expect(200);
    const media = res.headers['set-cookie'].find((c) => c.startsWith('temu_media='));
    assert.match(media, /HttpOnly/);
    assert.match(media, /SameSite=Strict/);
    assert.match(media, /Path=\/api\/attachments/);
    // It is not accepted as general API authentication.
    await request.get('/api/auth/me').set('Cookie', media.split(';')[0]).expect(401);
  });

  test('replaying an old refresh token after the grace window revokes the session', async () => {
    const { cookie, user } = await registerUser(request);
    const first = await request.post('/api/auth/refresh').set(XHR).set('Cookie', cookie).expect(200);
    const current = first.headers['set-cookie'][0].split(';')[0];
    await pool.query('UPDATE sessions SET rotated_at = ? WHERE user_id = ?', [new Date(Date.now() - 60_000), user.id]);

    await request.post('/api/auth/refresh').set(XHR).set('Cookie', cookie).expect(401);
    // The whole session is now dead, including the legitimately rotated token and access token.
    await request.post('/api/auth/refresh').set(XHR).set('Cookie', current).expect(401);
    await request.get('/api/auth/me').set(auth(first.body.accessToken)).expect(401);
  });

  test('logout revokes the session and its access token immediately', async () => {
    const { cookie, token } = await registerUser(request);
    await request.get('/api/auth/me').set(auth(token)).expect(200);
    await request.post('/api/auth/logout').set(XHR).set('Cookie', cookie).expect(204);
    await request.get('/api/auth/me').set(auth(token)).expect(401);
    await request.post('/api/auth/refresh').set(XHR).set('Cookie', cookie).expect(401);
  });

  test('logout-all revokes every session of the user', async () => {
    const reg = await registerUser(request);
    const second = await request.post('/api/auth/login').send({ email: reg.user.email, password: reg.password }).expect(200);
    await request.post('/api/auth/logout-all').set(auth(reg.token)).expect(204);
    await request.get('/api/auth/me').set(auth(second.body.accessToken)).expect(401);
  });
});
