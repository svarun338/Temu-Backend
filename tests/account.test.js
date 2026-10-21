import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auth, closeAll, pool, registerUser, resetDatabase, startServer, waitFor } from './helpers.js';

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

/** Pretend the last code was issued long ago, to get past the resend cooldown. */
async function skipCooldown(email) {
  await pool.query(
    `UPDATE email_otps o JOIN users u ON u.id = o.user_id
        SET o.created_at = o.created_at - INTERVAL 5 MINUTE WHERE u.email = ?`,
    [email],
  );
}

const register = (email, overrides = {}) =>
  request.post('/api/auth/register').send({ name: 'Otto', email, password: 'password123', ...overrides });

describe('email verification (OTP)', () => {
  test('stores only an HMAC of the code, never the code itself', async () => {
    const res = await register('hash@example.com').expect(201);
    const [rows] = await pool.query(
      "SELECT o.code_hash FROM email_otps o JOIN users u ON u.id = o.user_id WHERE u.email = 'hash@example.com'",
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].code_hash, /^[a-f0-9]{64}$/);
    assert.ok(!rows[0].code_hash.includes(res.body.devOtp));
  });

  test('an unverified user cannot log in and receives a fresh code instead', async () => {
    await register('pending@example.com').expect(201);
    await skipCooldown('pending@example.com');
    const res = await request.post('/api/auth/login').send({ email: 'pending@example.com', password: 'password123' }).expect(403);
    assert.equal(res.body.error.code, 'EMAIL_NOT_VERIFIED');
    assert.equal(res.body.error.details.email, 'pending@example.com');
    assert.match(res.body.error.details.devOtp, /^\d{6}$/);

    // The new code works; the login afterwards succeeds.
    await request.post('/api/auth/verify-email').send({ email: 'pending@example.com', code: res.body.error.details.devOtp }).expect(200);
    await request.post('/api/auth/login').send({ email: 'pending@example.com', password: 'password123' }).expect(200);
  });

  test('the wrong password for an unverified account still gives the generic error', async () => {
    await register('pending2@example.com').expect(201);
    const res = await request.post('/api/auth/login').send({ email: 'pending2@example.com', password: 'wrongpass1' }).expect(401);
    assert.equal(res.body.error.message, 'Invalid email or password');
  });

  test('wrong codes are limited to 5 attempts, then the code is burnt', async () => {
    const { body } = await register('guess@example.com').expect(201);
    const wrong = body.devOtp === '000000' ? '111111' : '000000';
    for (let i = 4; i >= 1; i -= 1) {
      const res = await request.post('/api/auth/verify-email').send({ email: 'guess@example.com', code: wrong }).expect(400);
      assert.equal(res.body.error.details.attemptsLeft, i);
    }
    await request.post('/api/auth/verify-email').send({ email: 'guess@example.com', code: wrong }).expect(400);
    // Even the right code no longer works.
    const res = await request.post('/api/auth/verify-email').send({ email: 'guess@example.com', code: body.devOtp }).expect(400);
    assert.equal(res.body.error.code, 'INVALID_CODE');
  });

  test('expired codes are rejected', async () => {
    const { body } = await register('late@example.com').expect(201);
    await pool.query(
      "UPDATE email_otps o JOIN users u ON u.id = o.user_id SET o.expires_at = NOW(3) - INTERVAL 1 MINUTE WHERE u.email = 'late@example.com'",
    );
    await request.post('/api/auth/verify-email').send({ email: 'late@example.com', code: body.devOtp }).expect(400);
  });

  test('a code can only be used once', async () => {
    const { body } = await register('once@example.com').expect(201);
    await request.post('/api/auth/verify-email').send({ email: 'once@example.com', code: body.devOtp }).expect(200);
    const again = await request.post('/api/auth/verify-email').send({ email: 'once@example.com', code: body.devOtp }).expect(409);
    assert.equal(again.body.error.code, 'ALREADY_VERIFIED');
  });

  test('resending is rate limited by a cooldown and replaces the old code', async () => {
    const first = await register('resend@example.com').expect(201);
    const tooSoon = await request.post('/api/auth/resend-verification').send({ email: 'resend@example.com' }).expect(429);
    assert.equal(tooSoon.body.error.code, 'OTP_COOLDOWN');
    assert.ok(tooSoon.body.error.details.retryAfterSeconds > 0);

    await skipCooldown('resend@example.com');
    const second = await request.post('/api/auth/resend-verification').send({ email: 'resend@example.com' }).expect(200);
    assert.match(second.body.devOtp, /^\d{6}$/);

    if (first.body.devOtp !== second.body.devOtp) {
      await request.post('/api/auth/verify-email').send({ email: 'resend@example.com', code: first.body.devOtp }).expect(400);
    }
    await request.post('/api/auth/verify-email').send({ email: 'resend@example.com', code: second.body.devOtp }).expect(200);
  });

  test('resend gives the same answer for unknown emails (no account discovery)', async () => {
    const res = await request.post('/api/auth/resend-verification').send({ email: 'ghost@example.com' }).expect(200);
    assert.equal(res.body.sent, true);
    assert.equal(res.body.devOtp, undefined);
  });

  test('re-registering a never-verified email replaces its password', async () => {
    await register('squat@example.com', { password: 'squatter123' }).expect(201);
    await skipCooldown('squat@example.com');
    const owner = await register('squat@example.com', { name: 'Real Owner', password: 'owner12345' }).expect(201);
    const verified = await request.post('/api/auth/verify-email').send({ email: 'squat@example.com', code: owner.body.devOtp }).expect(200);
    assert.equal(verified.body.user.name, 'Real Owner');
    await request.post('/api/auth/login').send({ email: 'squat@example.com', password: 'squatter123' }).expect(401);
    await request.post('/api/auth/login').send({ email: 'squat@example.com', password: 'owner12345' }).expect(200);
  });

  test('unverified accounts do not appear in search', async () => {
    const searcher = await registerUser(request, { name: 'Searcher' });
    await register('hidden-person@example.com', { name: 'Hidden Person' }).expect(201);
    const res = await request.get('/api/users/search?q=hidden').set(auth(searcher.token)).expect(200);
    assert.equal(res.body.users.length, 0);
  });

  test('rejects malformed codes', async () => {
    const res = await request.post('/api/auth/verify-email').send({ email: 'once@example.com', code: '12ab' }).expect(422);
    assert.equal(res.body.error.details[0].field, 'code');
  });
});

describe('forgot / reset password', () => {
  test('answers the same way for known and unknown emails', async () => {
    await registerUser(request, { email: 'forgetful@example.com' });
    const known = await request.post('/api/auth/forgot-password').send({ email: 'forgetful@example.com' }).expect(200);
    const unknown = await request.post('/api/auth/forgot-password').send({ email: 'nobody-here@example.com' }).expect(200);
    assert.equal(known.body.sent, true);
    assert.equal(unknown.body.sent, true);
    assert.equal(typeof unknown.body.retryAfterSeconds, 'number');
    assert.match(known.body.devOtp, /^\d{6}$/); // development display only
  });

  test('resets the password with the code and signs out every session and socket', async () => {
    const user = await registerUser(request, { email: 'reset-me@example.com', password: 'oldpass123' });
    const socket = await server.connect(user.token);
    const revoked = waitFor(socket, 'auth:revoked');

    await skipCooldown('reset-me@example.com');
    const { body } = await request.post('/api/auth/forgot-password').send({ email: 'reset-me@example.com' }).expect(200);
    await request
      .post('/api/auth/reset-password')
      .send({ email: 'reset-me@example.com', code: body.devOtp, password: 'newpass456' })
      .expect(200);
    await revoked;

    await request.get('/api/auth/me').set(auth(user.token)).expect(401);
    await request.post('/api/auth/login').send({ email: 'reset-me@example.com', password: 'oldpass123' }).expect(401);
    await request.post('/api/auth/login').send({ email: 'reset-me@example.com', password: 'newpass456' }).expect(200);
  });

  test('rejects a wrong code and weak new passwords', async () => {
    await registerUser(request, { email: 'reset-two@example.com' });
    const { body } = await request.post('/api/auth/forgot-password').send({ email: 'reset-two@example.com' }).expect(200);
    const wrong = body.devOtp === '000000' ? '111111' : '000000';
    await request
      .post('/api/auth/reset-password')
      .send({ email: 'reset-two@example.com', code: wrong, password: 'newpass456' })
      .expect(400);
    const weak = await request
      .post('/api/auth/reset-password')
      .send({ email: 'reset-two@example.com', code: body.devOtp, password: 'short' })
      .expect(422);
    assert.equal(weak.body.error.details[0].field, 'password');
  });

  test('a verification code cannot be used to reset a password', async () => {
    const reg = await register('cross@example.com').expect(201);
    await request
      .post('/api/auth/reset-password')
      .send({ email: 'cross@example.com', code: reg.body.devOtp, password: 'newpass456' })
      .expect(400);
  });
});
