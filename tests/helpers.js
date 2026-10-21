// Must be the first import of every test file: configures the test environment
// before any application module reads its configuration.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything below until the first `await` runs before any other module of a test file
// is evaluated, so test files may import application modules statically.

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(serverRoot, '.env')); // reuse local DB credentials
} catch {
  // CI: rely on real environment variables.
}
process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'temu_test';
process.env.JWT_ACCESS_SECRET ||= 'test-secret-that-is-definitely-longer-than-32-chars';
process.env.BCRYPT_ROUNDS = '4';
// Codes are returned in responses only when explicitly enabled (never in production).
process.env.OTP_DEV_DISPLAY = 'true';
// Test uploads go to a throwaway folder, never the real server/uploads.
process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'temu-test-uploads');
// Small limits so size checks can be tested quickly.
process.env.MAX_IMAGE_MB = '1';
process.env.MAX_AUDIO_MB = '1';
// Push is tested with its own keys; the real ones in .env are never used by tests.
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';
// Calls: unanswered calls time out, and dropped tabs are given up on, after 1 second.
process.env.CALL_RING_SECONDS = '1';
process.env.CALL_RECONNECT_GRACE_SECONDS = '1';
process.env.STUN_URLS = 'stun:stun.example.test:3478';
process.env.TURN_URLS = 'turn:turn.example.test:3478';
process.env.TURN_SECRET = 'turn-test-secret';
// Recordings: stored on the local test disk, saved 1 second after the call ends, at most 1 MB.
process.env.STORAGE_DRIVER = 'local';
process.env.RECORDING_FINALIZE_SECONDS = '1';
process.env.MAX_RECORDING_MB = '1';

const http = await import('node:http');
const { io: ioClient } = await import('socket.io-client');
const { default: supertest } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { pool, closePool } = await import('../src/db/pool.js');
const { createDatabase, migrateUp } = await import('../src/db/migrator.js');
const { createSocketServer } = await import('../src/sockets/index.js');
const { presenceService } = await import('../src/services/presenceService.js');
const { realtime } = await import('../src/sockets/realtime.js');
const { callService } = await import('../src/services/callService.js');
const { recordingService } = await import('../src/services/recordingService.js');
const { messageService } = await import('../src/services/messageService.js');
const { objectStorage, createS3Storage } = await import('../src/services/objectStorage.js');
const { Readable } = await import('node:stream');

/** An in-memory S3 bucket that speaks the AWS SDK's command objects (Put, Get with Range, Head, Delete). */
export function fakeS3() {
  const objects = new Map();
  const calls = [];
  return {
    objects,
    calls,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      calls.push({ name, input });
      if (name === 'PutObjectCommand') {
        let body = input.Body;
        if (!Buffer.isBuffer(body)) {
          const chunks = [];
          for await (const chunk of body) chunks.push(chunk);
          body = Buffer.concat(chunks);
        }
        objects.set(input.Key, { body, contentType: input.ContentType, encryption: input.ServerSideEncryption });
        return {};
      }
      if (name === 'GetObjectCommand' || name === 'HeadObjectCommand') {
        const object = objects.get(input.Key);
        if (!object) throw Object.assign(new Error('Not found'), { name: name === 'HeadObjectCommand' ? 'NotFound' : 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        if (name === 'HeadObjectCommand') return { ContentLength: object.body.length, ContentType: object.contentType };
        let body = object.body;
        const match = input.Range && /^bytes=(\d+)-(\d+)$/.exec(input.Range);
        if (match) body = body.subarray(Number(match[1]), Number(match[2]) + 1);
        return { Body: Readable.from([body]) };
      }
      if (name === 'DeleteObjectCommand') {
        objects.delete(input.Key);
        return {};
      }
      throw new Error(`Unexpected ${name}`);
    },
  };
}

// TEST_STORAGE=s3 npm test: every stored file goes to an in-memory S3 bucket instead of the disk.
export const testBucket = process.env.TEST_STORAGE === 's3' ? fakeS3() : null;
if (testBucket) objectStorage.useDriver('s3', createS3Storage({ bucket: 'temu-test-bucket', client: testBucket }), { current: true });

/** Is a file stored under this key (in whichever storage the tests use)? */
export async function storedFileExists(key) {
  try {
    await objectStorage.current.stat(key);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** The bytes stored under this key. */
export async function readStoredFile(key) {
  const chunks = [];
  for await (const chunk of await objectStorage.current.read(key)) chunks.push(chunk);
  return Buffer.concat(chunks);
}
const { settlePresence } = await import('../src/sockets/handlers/presenceHandlers.js');

export { pool };

/** Fresh, migrated, empty test database. */
export async function resetDatabase() {
  await createDatabase();
  await migrateUp({ log: () => {} });
  // Every table except the migration bookkeeping, so new tables can never be forgotten here.
  const [tables] = await pool.query(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name <> 'schema_migrations'",
  );
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const { name } of tables) await pool.query(`TRUNCATE TABLE \`${name}\``);
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  presenceService.reset();
  callService.reset();
  recordingService.reset();
  messageService.resetGroupStatus();
}

/** Start the full HTTP + Socket.IO stack on a random port. */
export async function startServer() {
  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}`;
  const sockets = new Set();

  return {
    url,
    request: supertest(app),
    /** Connect a socket client and wait until the server finished its setup. */
    async connect(token, { onSocket, ...options } = {}) {
      const socket = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, ...options });
      sockets.add(socket);
      onSocket?.(socket); // attach listeners for events sent together with session:ready
      await new Promise((resolve, reject) => {
        socket.once('session:ready', resolve);
        socket.once('connect_error', reject);
      });
      return socket;
    },
    async close() {
      for (const socket of sockets) socket.disconnect();
      io.close();
      callService.reset();
      recordingService.reset();
      await settlePresence();
      realtime.detach();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function closeAll() {
  await closePool();
}

let counter = 0;
/** Register a user, verify the email with the development OTP and return { user, token, cookie, password }. */
export async function registerUser(request, overrides = {}) {
  counter += 1;
  const body = {
    name: overrides.name ?? `User ${counter}`,
    email: overrides.email ?? `user${counter}_${Date.now()}@example.com`,
    password: overrides.password ?? 'password123',
  };
  const registered = await request.post('/api/auth/register').send(body).expect(201);
  const res = await request
    .post('/api/auth/verify-email')
    .send({ email: body.email, code: registered.body.devOtp })
    .expect(200);
  return {
    user: res.body.user,
    token: res.body.accessToken,
    cookie: res.headers['set-cookie'][0].split(';')[0],
    password: body.password,
  };
}

export const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Resolve with the next `event` payload matching `predicate`, or reject after `timeout`. */
export function waitFor(socket, event, predicate = () => true, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeout);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

/** Assert that `event` is NOT received within `ms`. */
export function expectNoEvent(socket, event, ms = 300) {
  return new Promise((resolve, reject) => {
    const handler = (payload) => {
      socket.off(event, handler);
      reject(new Error(`Unexpected "${event}": ${JSON.stringify(payload)}`));
    };
    socket.on(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
  });
}

/** Emit with acknowledgement as a promise. */
export function emitAck(socket, event, payload) {
  return socket.timeout(2000).emitWithAck(event, payload);
}

/** Make `a` and `b` contacts of each other and open their conversation. */
export async function connectUsers(request, a, b) {
  await request.post('/api/contacts').set(auth(a.token)).send({ userId: b.user.id }).expect(201);
  await request.post('/api/contacts').set(auth(b.token)).send({ userId: a.user.id }).expect(201);
  const res = await request.post('/api/conversations').set(auth(a.token)).send({ userId: b.user.id }).expect(201);
  return res.body.conversation;
}
