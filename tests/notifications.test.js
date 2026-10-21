import { after, before, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import webpush from 'web-push';
import { auth, closeAll, connectUsers, pool, registerUser, resetDatabase, startServer, waitFor } from './helpers.js';

let server;
let request;
let alice;
let bob;
let ab;
let config;
let sent; // payloads "delivered" to the fake push service
let pushFails; // status code the fake push service answers with (null = success)

const SUBSCRIPTION = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint-1',
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
};

/** Wait for fire-and-forget work (notifications run after the HTTP response). */
async function eventually(check, timeout = 2000) {
  const start = Date.now();
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

before(async () => {
  await resetDatabase();
  ({ config } = await import('../src/config/index.js'));
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice Notify' });
  bob = await registerUser(request, { name: 'Bob Notify' });
  ab = await connectUsers(request, alice, bob);

  mock.method(webpush, 'sendNotification', async (subscription, payload) => {
    if (pushFails) throw Object.assign(new Error('push failed'), { statusCode: pushFails });
    sent.push({ endpoint: subscription.endpoint, ...JSON.parse(payload) });
    return { statusCode: 201 };
  });
});

beforeEach(async () => {
  sent = [];
  pushFails = null;
  // Push on, with a real-format key pair (only used to sign; nothing leaves the test).
  const keys = webpush.generateVAPIDKeys();
  config.push.publicKey = keys.publicKey;
  config.push.privateKey = keys.privateKey;
  await request.patch('/api/settings').set(auth(bob.token)).send({ notificationsEnabled: true, messagePreview: true });
  await request.delete(`/api/conversations/${ab.id}/mute`).set(auth(bob.token));
  await request.post('/api/push/subscriptions').set(auth(bob.token)).send(SUBSCRIPTION);
});

after(async () => {
  mock.restoreAll();
  await server.close();
  await closeAll();
});

const send = (user, body) => request.post(`/api/conversations/${ab.id}/messages`).set(auth(user.token)).send({ body }).expect(201);

describe('settings', () => {
  test('have defaults, can be changed and validate input', async () => {
    const { settings } = (await request.get('/api/settings').set(auth(alice.token)).expect(200)).body;
    assert.deepEqual(
      { n: settings.notificationsEnabled, p: settings.messagePreview, s: settings.soundEnabled, push: settings.push.available },
      { n: true, p: true, s: true, push: true },
    );
    assert.ok(settings.push.publicKey);

    const socket = await server.connect(alice.token);
    const pushed = waitFor(socket, 'settings:updated', (s) => s.soundEnabled === false);
    const res = await request.patch('/api/settings').set(auth(alice.token)).send({ soundEnabled: false }).expect(200);
    assert.equal(res.body.settings.soundEnabled, false);
    await pushed;
    socket.disconnect();

    await request.patch('/api/settings').set(auth(alice.token)).send({}).expect(422);
    await request.patch('/api/settings').set(auth(alice.token)).send({ soundEnabled: 'yes' }).expect(422);
  });
});

describe('muting a chat', () => {
  test('mute for 8 hours, then unmute; only participants can', async () => {
    // Bob only sees the chat in his list once it has a message.
    const bobSocket = await server.connect(bob.token); // online: no push noise for this test
    await send(alice, 'First message');
    bobSocket.disconnect();
    const res = await request.put(`/api/conversations/${ab.id}/mute`).set(auth(bob.token)).send({ duration: '8h' }).expect(200);
    const hours = (new Date(res.body.mutedUntil) - Date.now()) / 3_600_000;
    assert.ok(hours > 7.9 && hours <= 8);

    const list = (await request.get('/api/conversations').set(auth(bob.token))).body.conversations;
    assert.ok(list.find((c) => c.id === ab.id).mutedUntil);
    const alicesView = (await request.get('/api/conversations').set(auth(alice.token))).body.conversations;
    assert.equal(alicesView.find((c) => c.id === ab.id).mutedUntil, null, 'muting is personal');

    await request.delete(`/api/conversations/${ab.id}/mute`).set(auth(bob.token)).expect(200);
    const after = (await request.get('/api/conversations').set(auth(bob.token))).body.conversations;
    assert.equal(after.find((c) => c.id === ab.id).mutedUntil, null);

    await request.put(`/api/conversations/${ab.id}/mute`).set(auth(bob.token)).send({ duration: '3d' }).expect(422);
    const carol = await registerUser(request, { name: 'Carol Notify' });
    await request.put(`/api/conversations/${ab.id}/mute`).set(auth(carol.token)).send({ duration: 'always' }).expect(404);
  });
});

describe('push notifications', () => {
  test('a recipient with TEMU closed gets a push with the sender and a preview', async () => {
    await send(alice, 'Dinner at 8?');
    await eventually(() => assert.equal(sent.length, 1));
    assert.deepEqual(sent[0], {
      endpoint: SUBSCRIPTION.endpoint,
      title: 'Alice Notify',
      body: 'Dinner at 8?',
      tag: `conversation-${ab.id}`,
      url: `/c/${ab.id}`,
    });
  });

  test('previews can be hidden', async () => {
    await request.patch('/api/settings').set(auth(bob.token)).send({ messagePreview: false }).expect(200);
    await send(alice, 'Secret plans');
    await eventually(() => assert.equal(sent.length, 1));
    assert.equal(sent[0].body, 'New message');
  });

  test('no push while the recipient has TEMU open (the tab notifies itself)', async () => {
    const socket = await server.connect(bob.token);
    await send(alice, 'You are online');
    await settle();
    assert.equal(sent.length, 0);
    socket.disconnect();
  });

  test('muted chats and disabled notifications stay silent', async () => {
    await request.put(`/api/conversations/${ab.id}/mute`).set(auth(bob.token)).send({ duration: 'always' }).expect(200);
    await send(alice, 'Muted message');
    await settle();
    assert.equal(sent.length, 0);

    await request.delete(`/api/conversations/${ab.id}/mute`).set(auth(bob.token)).expect(200);
    await request.patch('/api/settings').set(auth(bob.token)).send({ notificationsEnabled: false }).expect(200);
    await send(alice, 'Notifications off');
    await settle();
    assert.equal(sent.length, 0);
  });

  test('an @mention gets through a mute', async () => {
    await request.put(`/api/conversations/${ab.id}/mute`).set(auth(bob.token)).send({ duration: 'always' }).expect(200);
    await send(alice, 'Hey @Bob, look at this');
    await eventually(() => assert.equal(sent.length, 1));
    assert.equal(sent[0].title, 'Alice Notify mentioned you');
  });

  test('expired subscriptions are removed', async () => {
    pushFails = 410;
    await send(alice, 'Anyone there?');
    await eventually(async () => {
      const [rows] = await pool.query('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [bob.user.id]);
      assert.equal(Number(rows[0].n), 0);
    });
  });

  test('logging out stops push on that device', async () => {
    const extra = await request.post('/api/auth/login').send({ email: bob.user.email, password: bob.password }).expect(200);
    const cookie = extra.headers['set-cookie'].find((c) => c.startsWith('temu_refresh=')).split(';')[0];
    await request.post('/api/push/subscriptions').set(auth(extra.body.accessToken)).send({ ...SUBSCRIPTION, endpoint: `${SUBSCRIPTION.endpoint}-2` }).expect(201);
    await request.post('/api/auth/logout').set('X-Requested-With', 'XMLHttpRequest').set('Cookie', cookie).expect(204);
    const [rows] = await pool.query('SELECT endpoint FROM push_subscriptions WHERE user_id = ?', [bob.user.id]);
    assert.deepEqual(rows.map((r) => r.endpoint), [SUBSCRIPTION.endpoint]);
  });

  test('subscriptions must point at a real push service', async () => {
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://192.168.1.5/x', 'not a url']) {
      const res = await request.post('/api/push/subscriptions').set(auth(bob.token)).send({ ...SUBSCRIPTION, endpoint });
      assert.ok([400, 422].includes(res.status), `${endpoint} → ${res.status}`);
    }
  });

  test('without server keys push is reported as unavailable', async () => {
    config.push.publicKey = '';
    const { settings } = (await request.get('/api/settings').set(auth(bob.token))).body;
    assert.equal(settings.push.available, false);
    await request.post('/api/push/subscriptions').set(auth(bob.token)).send(SUBSCRIPTION).expect(503);
  });
});

describe('notification centre', () => {
  test('mentions are recorded, delivered live, listed and can be marked read', async () => {
    const bobSocket = await server.connect(bob.token);
    const live = waitFor(bobSocket, 'notification:new', (n) => n.type === 'mention');
    const message = (await send(alice, '@Bob Notify can you check?')).body.message;
    const event = await live;
    assert.equal(event.actor.name, 'Alice Notify');
    assert.equal(event.messageId, message.id);

    const list = (await request.get('/api/notifications').set(auth(bob.token)).expect(200)).body;
    assert.ok(list.unread >= 1);
    assert.equal(list.notifications[0].preview, '@Bob Notify can you check?');

    const read = (await request.post('/api/notifications/read').set(auth(bob.token)).send({}).expect(200)).body;
    assert.equal(read.unread, 0);
    bobSocket.disconnect();
  });

  test('"added you as a contact" is recorded for the person added', async () => {
    const dave = await registerUser(request, { name: 'Dave Notify' });
    await request.post('/api/contacts').set(auth(dave.token)).send({ userId: alice.user.id }).expect(201);
    await eventually(async () => {
      const { notifications } = (await request.get('/api/notifications').set(auth(alice.token))).body;
      assert.equal(notifications[0].type, 'contact_added');
      assert.equal(notifications[0].actor.name, 'Dave Notify');
    });
    // Blocking hides their notifications.
    await request.post('/api/blocks').set(auth(alice.token)).send({ userId: dave.user.id }).expect(201);
    const { notifications } = (await request.get('/api/notifications').set(auth(alice.token))).body;
    assert.ok(!notifications.some((n) => n.actor?.name === 'Dave Notify'));
  });

  test('mention detection', async () => {
    const { mentions } = await import('../src/services/notificationService.js');
    assert.equal(mentions('hi @Bob!', 'Bob Notify'), true);
    assert.equal(mentions('hi @bob notify', 'Bob Notify'), true);
    assert.equal(mentions('hi @Bobby', 'Bob Notify'), false);
    assert.equal(mentions('mail bob@example.com', 'Bob Notify'), false);
    assert.equal(mentions('no mention here, Bob', 'Bob Notify'), false);
  });
});
