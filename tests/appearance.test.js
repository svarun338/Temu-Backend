import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auth, closeAll, connectUsers, registerUser, resetDatabase, startServer, waitFor } from './helpers.js';

let server;
let request;
let alice;
let bob;
let carol;
let ab;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 5)]);

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice Looks' });
  bob = await registerUser(request, { name: 'Bob Looks' });
  carol = await registerUser(request, { name: 'Carol Looks' });
  ab = await connectUsers(request, alice, bob);
});

after(async () => {
  await server.close();
  await closeAll();
});

const patch = (user, body) => request.patch('/api/settings').set(auth(user.token)).send(body);
const upload = (user, buffer = PNG, name = 'wall.png') => request.post('/api/wallpapers').set(auth(user.token)).attach('image', buffer, name);

describe('appearance settings', () => {
  test('defaults, partial updates and live sync to other tabs', async () => {
    const { settings } = (await request.get('/api/settings').set(auth(alice.token)).expect(200)).body;
    assert.deepEqual(settings.appearance, { theme: 'system', accent: 'indigo', fontSize: 'medium', bubbleStyle: 'rounded', defaultWallpaper: null });

    const socket = await server.connect(alice.token);
    const synced = waitFor(socket, 'settings:updated', (s) => s.appearance.theme === 'dark');
    const res = await patch(alice, { appearance: { theme: 'dark', accent: 'emerald' } }).expect(200);
    assert.equal(res.body.settings.appearance.theme, 'dark');
    assert.equal(res.body.settings.appearance.fontSize, 'medium', 'untouched fields keep their value');
    await synced;
    socket.disconnect();

    await patch(alice, { appearance: { fontSize: 'large', bubbleStyle: 'square', defaultWallpaper: 'preset:ocean' } }).expect(200);
    const after = (await request.get('/api/settings').set(auth(alice.token))).body.settings;
    assert.deepEqual(after.appearance, { theme: 'dark', accent: 'emerald', fontSize: 'large', bubbleStyle: 'square', defaultWallpaper: 'preset:ocean' });
    assert.equal(after.notificationsEnabled, true, 'appearance changes do not touch notification settings');
  });

  test('rejects unknown values', async () => {
    await patch(alice, { appearance: { theme: 'neon' } }).expect(422);
    await patch(alice, { appearance: { accent: '#ff0000' } }).expect(422);
    await patch(alice, { appearance: {} }).expect(422);
    await patch(alice, { appearance: { defaultWallpaper: 'preset:unknown' } }).expect(400);
    await patch(alice, { appearance: { defaultWallpaper: 'url(javascript:alert(1))' } }).expect(422);
  });
});

describe('wallpapers', () => {
  test('upload, use as default and per chat, list and delete', async () => {
    const { wallpaper } = (await upload(alice).expect(201)).body;
    assert.match(wallpaper.url, /^\/uploads\/wallpapers\/[a-f0-9]{32}\.png$/);
    assert.equal(wallpaper.value, `custom:${wallpaper.id}`);
    const served = await request.get(wallpaper.url).expect(200);
    assert.equal(served.headers['x-content-type-options'], 'nosniff');

    await patch(alice, { appearance: { defaultWallpaper: wallpaper.value } }).expect(200);
    await request.put(`/api/conversations/${ab.id}/wallpaper`).set(auth(alice.token)).send({ wallpaper: wallpaper.value }).expect(200);

    const list = (await request.get('/api/wallpapers').set(auth(alice.token)).expect(200)).body.wallpapers;
    assert.deepEqual(list.map((w) => w.id), [wallpaper.id]);

    // Deleting it resets everything that used it to the default.
    await request.delete(`/api/wallpapers/${wallpaper.id}`).set(auth(alice.token)).expect(204);
    const settings = (await request.get('/api/settings').set(auth(alice.token))).body.settings;
    assert.equal(settings.appearance.defaultWallpaper, null);
    await request.get(wallpaper.url).expect(404);
  });

  test('per-chat wallpapers are personal and need membership', async () => {
    await request.put(`/api/conversations/${ab.id}/wallpaper`).set(auth(alice.token)).send({ wallpaper: 'preset:forest' }).expect(200);
    await request.post(`/api/conversations/${ab.id}/messages`).set(auth(alice.token)).send({ body: 'hi' }).expect(201);

    const mine = (await request.get('/api/conversations').set(auth(alice.token))).body.conversations.find((c) => c.id === ab.id);
    const his = (await request.get('/api/conversations').set(auth(bob.token))).body.conversations.find((c) => c.id === ab.id);
    assert.equal(mine.wallpaper, 'preset:forest');
    assert.equal(his.wallpaper, null, "Bob's chat looks the way Bob chose");

    await request.put(`/api/conversations/${ab.id}/wallpaper`).set(auth(carol.token)).send({ wallpaper: 'preset:forest' }).expect(404);
    await request.put(`/api/conversations/${ab.id}/wallpaper`).set(auth(alice.token)).send({ wallpaper: null }).expect(200);
  });

  test("nobody can use or delete someone else's wallpaper", async () => {
    const { wallpaper } = (await upload(alice).expect(201)).body;
    await patch(bob, { appearance: { defaultWallpaper: wallpaper.value } }).expect(400);
    await request.put(`/api/conversations/${ab.id}/wallpaper`).set(auth(bob.token)).send({ wallpaper: wallpaper.value }).expect(400);
    await request.delete(`/api/wallpapers/${wallpaper.id}`).set(auth(bob.token)).expect(404);
  });

  test('only real images are accepted', async () => {
    await upload(alice, Buffer.from('<svg onload="alert(1)"/>'), 'x.png').expect(415);
    await upload(alice, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]), 'x.jpg').expect(415);
    await request.post('/api/wallpapers').set(auth(alice.token)).expect(400);
  });
});
