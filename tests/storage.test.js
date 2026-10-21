import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { auth, closeAll, connectUsers, fakeS3, pool, registerUser, resetDatabase, startServer } from './helpers.js';
import { config } from '../src/config/index.js';
import { attachmentStorage } from '../src/services/attachmentStorage.js';
import { createS3Storage, objectStorage } from '../src/services/objectStorage.js';

/**
 * Where every kind of file is stored: with STORAGE_DRIVER=s3 everything goes to S3
 * (attachments, previews, stickers, profile photos, wallpapers); with local, the disk.
 * Each test here installs an in-memory S3 bucket as the S3 driver.
 */
let server;
let request;
let alice;
let bob;
let chat;
let bucket;
let saved;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(512, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(8192, 3)]);

const useS3 = () => {
  bucket = fakeS3();
  objectStorage.useDriver('s3', createS3Storage({ bucket: 'temu-media-prod', prefix: 'prod/', client: bucket }), { current: true });
};
const useDisk = () => objectStorage.useDriver('local', null, { current: true });
const onDisk = (key) => path.join(config.uploads.dir, ...key.split('/'));
const exists = (file) => fs.access(file).then(() => true, () => false);

function upload(buffer, name, fields = {}) {
  let req = request.post('/api/attachments').set(auth(alice.token)).field('conversationId', String(chat.id));
  for (const [key, value] of Object.entries(fields)) req = req.field(key, String(value));
  return req.attach('file', buffer, name);
}

async function send(attachmentIds) {
  return (await request.post(`/api/conversations/${chat.id}/messages`).set(auth(alice.token)).send({ attachmentIds }).expect(201)).body.message;
}

const keyOf = async (attachmentId, column = 'storage_key') => (await pool.query(`SELECT ${column} AS k FROM attachments WHERE id = ?`, [attachmentId]))[0][0].k;

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice Storage' });
  bob = await registerUser(request, { name: 'Bob Storage' });
  chat = await connectUsers(request, alice, bob);
  saved = objectStorage.snapshot();
});

afterEach(() => objectStorage.restore(saved));

after(async () => {
  await server.close();
  await closeAll();
});

describe('STORAGE_DRIVER=s3: every file goes to S3', () => {
  test('chat files and their previews: stored privately under prod/attachments/ab/<key>, downloaded with seeking, deleted with the message', async () => {
    useS3();
    const video = (await upload(MP4, 'clip.mp4').attach('thumbnail', JPG, 'thumb.jpg').expect(201)).body.attachment;
    const key = await keyOf(video.id);
    const thumbKey = await keyOf(video.id, 'thumbnail_key');

    const object = bucket.objects.get(`prod/attachments/${key.slice(0, 2)}/${key}`);
    assert.ok(object, 'the video is in the bucket');
    assert.equal(object.contentType, 'video/mp4');
    assert.equal(object.encryption, 'AES256');
    assert.equal(object.body.length, MP4.length);
    assert.equal(bucket.objects.get(`prod/attachments/${thumbKey.slice(0, 2)}/${thumbKey}`).contentType, 'image/jpeg');
    assert.equal(await exists(onDisk(attachmentStorage.objectKey(key))), false, 'nothing on the server disk');
    const temp = await fs.readdir(path.join(config.uploads.dir, 'tmp')).catch(() => []);
    assert.equal(temp.filter((f) => /^[a-f0-9]{32}$/.test(f)).length, 0, 'temp files cleaned up');

    const message = await send([video.id]);
    const whole = await request.get(video.url).set(auth(bob.token)).buffer(true).expect(200);
    assert.equal(whole.headers['content-type'], 'video/mp4');
    assert.equal(Number(whole.headers['content-length']), MP4.length);
    const part = await request.get(video.url).set(auth(bob.token)).set('Range', 'bytes=4-11').buffer(true).expect(206);
    assert.equal(part.headers['content-range'], `bytes 4-11/${MP4.length}`);
    assert.equal(Buffer.from(part.body).toString('ascii'), 'ftypisom');
    await request.get(`${video.url}/thumbnail`).set(auth(bob.token)).expect(200);
    await request.get(video.url).set('Cookie', `temu_media=${bob.token}`).expect(200); // <video> with the media cookie

    await request.delete(`/api/messages/${message.id}?scope=everyone`).set(auth(alice.token)).expect(200);
    assert.equal(bucket.objects.size, 0, 'video and preview deleted from S3');
  });

  test('profile photos: stored at avatars/<name>, served at the same URL, old one deleted', async () => {
    useS3();
    const first = (await request.put('/api/profile/avatar').set(auth(alice.token)).attach('avatar', PNG, 'me.png').expect(200)).body.user.avatarUrl;
    const name = path.basename(first);
    assert.equal(bucket.objects.get(`prod/avatars/${name}`).contentType, 'image/png');
    const served = await request.get(first).expect(200);
    assert.equal(served.headers['content-type'], 'image/png');
    assert.equal(served.headers['cache-control'], 'public, max-age=2592000, immutable');
    assert.match(served.headers['content-security-policy'], /sandbox/);

    await request.put('/api/profile/avatar').set(auth(alice.token)).attach('avatar', JPG, 'me.jpg').expect(200);
    assert.equal(bucket.objects.has(`prod/avatars/${name}`), false, 'old photo deleted');
    await request.get(first).expect(404);
    await request.get('/uploads/avatars/..%2F..%2F.env').expect(404);
  });

  test('wallpapers and stickers go to S3 too', async () => {
    useS3();
    const wallpaper = (await request.post('/api/wallpapers').set(auth(alice.token)).attach('image', PNG, 'wall.png').expect(201)).body.wallpaper;
    assert.ok(bucket.objects.has(`prod/wallpapers/${path.basename(wallpaper.url)}`));
    assert.equal((await request.get(wallpaper.url).expect(200)).headers['content-type'], 'image/png');
    await request.delete(`/api/wallpapers/${wallpaper.id}`).set(auth(alice.token)).expect(204);
    assert.equal(bucket.objects.has(`prod/wallpapers/${path.basename(wallpaper.url)}`), false);

    const sticker = (await request.post('/api/stickers').set(auth(alice.token)).attach('image', PNG, 's.png').expect(201)).body.sticker;
    const [[row]] = await pool.query('SELECT storage_key FROM user_stickers WHERE id = ?', [sticker.id]);
    assert.equal(bucket.objects.get(`prod/attachments/${row.storage_key.slice(0, 2)}/${row.storage_key}`).contentType, 'image/png');
    assert.equal((await request.get(sticker.url).set(auth(alice.token)).expect(200)).headers['content-type'], 'image/png');
  });

  test('switching from disk to S3: files saved before keep working and are deleted from the disk', async () => {
    useDisk();
    const old = (await upload(PNG, 'before.png').expect(201)).body.attachment;
    const oldKey = attachmentStorage.objectKey(await keyOf(old.id));
    assert.equal(await exists(onDisk(oldKey)), true);
    const message = await send([old.id]);

    useS3(); // STORAGE_DRIVER=s3 from now on
    const res = await request.get(old.url).set(auth(bob.token)).buffer(true).expect(200);
    assert.ok(Buffer.compare(Buffer.from(res.body), PNG) === 0, 'served from the disk');
    const fresh = (await upload(PNG, 'after.png').expect(201)).body.attachment;
    assert.ok(bucket.objects.has(`prod/${attachmentStorage.objectKey(await keyOf(fresh.id))}`), 'new files go to S3');

    await request.delete(`/api/messages/${message.id}?scope=everyone`).set(auth(alice.token)).expect(200);
    assert.equal(await exists(onDisk(oldKey)), false, 'the old file is deleted from the disk');
  });
});

describe('STORAGE_DRIVER=local: the disk layout is unchanged', () => {
  test('files are under UPLOAD_DIR/attachments/ab/<key>, avatars/ and wallpapers/', async () => {
    useDisk();
    const photo = (await upload(PNG, 'here.png').expect(201)).body.attachment;
    const key = await keyOf(photo.id);
    assert.equal(await exists(path.join(config.uploads.dir, 'attachments', key.slice(0, 2), key)), true);
    const avatar = (await request.put('/api/profile/avatar').set(auth(bob.token)).attach('avatar', PNG, 'b.png').expect(200)).body.user.avatarUrl;
    assert.equal(await exists(path.join(config.uploads.dir, 'avatars', path.basename(avatar))), true);
    const wallpaper = (await request.post('/api/wallpapers').set(auth(bob.token)).attach('image', PNG, 'w.png').expect(201)).body.wallpaper;
    assert.equal(await exists(path.join(config.uploads.dir, 'wallpapers', path.basename(wallpaper.url))), true);
    await request.get(avatar).expect(200);
    await request.get(wallpaper.url).expect(200);
  });
});
