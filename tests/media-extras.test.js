import { after, afterEach, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { auth, closeAll, connectUsers, registerUser, resetDatabase, startServer } from './helpers.js';

const bytes = (...values) => Buffer.from(values);
const PNG = Buffer.concat([bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), Buffer.alloc(300, 5)]);
const JPG = Buffer.concat([bytes(0xff, 0xd8, 0xff, 0xe0), Buffer.alloc(300, 1)]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF');
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(400, 9)]);

let server;
let request;
let config;
let alice;
let bob;
let eve; // outsider
let chat; // alice ↔ bob

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  ({ config } = await import('../src/config/index.js'));
  alice = await registerUser(request, { name: 'Alice Media' });
  bob = await registerUser(request, { name: 'Bob Media' });
  eve = await registerUser(request, { name: 'Eve Outsider' });
  chat = await connectUsers(request, alice, bob);
});

after(async () => {
  await server.close();
  await closeAll();
});

const upload = (user, file, name, fields = {}) => {
  let req = request.post('/api/attachments').set(auth(user.token)).field('conversationId', String(chat.id));
  for (const [key, value] of Object.entries(fields)) req = req.field(key, String(value));
  return req.attach('file', file, name);
};
const send = (user, body) => request.post(`/api/conversations/${chat.id}/messages`).set(auth(user.token)).send(body);

describe('document preview', () => {
  test('a PDF keeps its first-page preview and page count', async () => {
    const res = await request
      .post('/api/attachments')
      .set(auth(alice.token))
      .field('conversationId', String(chat.id))
      .field('pageCount', '12')
      .field('width', '480')
      .field('height', '679')
      .attach('file', PDF, 'report.pdf')
      .attach('thumbnail', JPG, 'thumbnail.jpg')
      .expect(201);
    const { attachment } = res.body;
    assert.equal(attachment.kind, 'file');
    assert.equal(attachment.pageCount, 12);
    assert.ok(attachment.thumbnailUrl);
    assert.deepEqual([attachment.width, attachment.height], [480, 679]);
    const thumb = await request.get(attachment.thumbnailUrl).set(auth(alice.token)).expect(200);
    assert.equal(thumb.headers['content-type'], 'image/jpeg');
  });

  test('page counts and previews are ignored for other files', async () => {
    const res = await upload(alice, Buffer.from('hello world\n'), 'notes.txt', { pageCount: 3 }).expect(201);
    assert.equal(res.body.attachment.pageCount, null);
    await upload(alice, PDF, 'x.pdf', { pageCount: 0 }).expect(422);
  });
});

describe('GIFs', () => {
  afterEach(() => {
    mock.restoreAll();
    config.gifs.giphyKey = '';
  });

  /** Fake GIPHY: API answers from `api`, media downloads from `media`. */
  function fakeGiphy({ api = {}, media = GIF } = {}) {
    config.gifs.giphyKey = 'test-giphy-key';
    const calls = [];
    mock.method(globalThis, 'fetch', async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.hostname === 'api.giphy.com') {
        assert.equal(url.searchParams.get('api_key'), 'test-giphy-key');
        const body = api[url.pathname] ?? { data: [], pagination: { total_count: 0 } };
        return new Response(JSON.stringify(body), { status: body.status ?? 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(media, { status: 200, headers: { 'content-type': 'image/gif', 'content-length': String(media.length) } });
    });
    return calls;
  }

  const gif = (id, host = 'media1.giphy.com') => ({
    id,
    title: `GIF ${id}`,
    images: {
      fixed_width_downsampled: { url: `https://${host}/media/${id}/200w_d.gif`, webp: `https://${host}/media/${id}/200w_d.webp`, width: '200', height: '150' },
      downsized_medium: { url: `https://${host}/media/${id}/giphy.gif`, width: '480', height: '360', size: '400' },
    },
  });

  test('without a GIPHY key, search is off but the app says so', async () => {
    const res = await request.get('/api/gifs/trending').set(auth(alice.token)).expect(503);
    assert.equal(res.body.error.code, 'GIFS_DISABLED');
    const settings = await request.get('/api/settings').set(auth(alice.token)).expect(200);
    assert.equal(settings.body.settings.gifs.search, false);
  });

  test('trending and search go through the server, keep only GIPHY media and page on', async () => {
    fakeGiphy({
      api: {
        '/v1/gifs/trending': { data: [gif('abc12'), gif('evil1', 'evil.example.com')], pagination: { total_count: 100 } },
        '/v1/gifs/search': { data: [gif('cat01')], pagination: { total_count: 1 } },
      },
    });
    const trending = (await request.get('/api/gifs/trending').set(auth(alice.token)).expect(200)).body;
    assert.deepEqual(trending.gifs.map((g) => g.id), ['abc12']); // the off-GIPHY result is dropped
    assert.match(trending.gifs[0].previewUrl, /^https:\/\/media1\.giphy\.com\//);
    assert.equal(trending.nextOffset, 24);
    const search = (await request.get('/api/gifs/search?q=cats').set(auth(alice.token)).expect(200)).body;
    assert.deepEqual(search.gifs.map((g) => g.id), ['cat01']);
    assert.equal(search.nextOffset, null);
    await request.get('/api/gifs/search?q=').set(auth(alice.token)).expect(422);
  });

  test('sending a GIF: the server fetches it from GIPHY by id and stores it; recipients get our copy', async () => {
    const calls = fakeGiphy({ api: { '/v1/gifs/abc12': { data: gif('abc12') } } });
    const res = await request.post('/api/gifs').set(auth(alice.token)).send({ conversationId: chat.id, gifId: 'abc12' }).expect(201);
    const { attachment } = res.body;
    assert.equal(attachment.mimeType, 'image/gif');
    assert.equal(attachment.kind, 'image');
    assert.equal(attachment.size, GIF.length);
    assert.ok(calls.some((u) => u.hostname === 'media1.giphy.com'));
    const message = (await send(alice, { attachmentIds: [attachment.id] }).expect(201)).body.message;
    const file = await request.get(message.attachments[0].url).set(auth(bob.token)).expect(200);
    assert.equal(file.headers['content-type'], 'image/gif');

    // Outsiders can't attach into a chat they're not in.
    await request.post('/api/gifs').set(auth(eve.token)).send({ conversationId: chat.id, gifId: 'abc12' }).expect(404);
    await request.post('/api/gifs').set(auth(alice.token)).send({ conversationId: chat.id, gifId: '../etc' }).expect(422);
  });

  test('only real GIFs from GIPHY servers are accepted', async () => {
    fakeGiphy({ api: { '/v1/gifs/bad01': { data: gif('bad01', 'internal.local') } } });
    await request.post('/api/gifs').set(auth(alice.token)).send({ conversationId: chat.id, gifId: 'bad01' }).expect(422);
    mock.restoreAll();
    fakeGiphy({ api: { '/v1/gifs/png01': { data: gif('png01') } }, media: PNG });
    const res = await request.post('/api/gifs').set(auth(alice.token)).send({ conversationId: chat.id, gifId: 'png01' }).expect(415);
    assert.equal(res.body.error.code, 'UNSUPPORTED_FILE');
  });

  test('recent GIFs (no key needed) and sending one again', async () => {
    const recent = (await request.get('/api/gifs/recent').set(auth(alice.token)).expect(200)).body.gifs;
    assert.equal(recent.length, 1);
    // Bob received it, so he may send it on too; Eve may not.
    const again = await request.post('/api/gifs/reuse').set(auth(bob.token)).send({ conversationId: chat.id, attachmentId: recent[0].id }).expect(201);
    assert.equal(again.body.attachment.mimeType, 'image/gif');
    await send(bob, { attachmentIds: [again.body.attachment.id] }).expect(201);
    await request.post('/api/gifs/reuse').set(auth(eve.token)).send({ conversationId: chat.id, attachmentId: recent[0].id }).expect(404);
    // Only GIFs can be reused this way.
    const photo = (await upload(alice, PNG, 'p.png').expect(201)).body.attachment;
    await request.post('/api/gifs/reuse').set(auth(alice.token)).send({ conversationId: chat.id, attachmentId: photo.id }).expect(404);
  });
});

describe('stickers', () => {
  test('built-in stickers are sent on their own and validated', async () => {
    const message = (await send(alice, { sticker: 'blob:love' }).expect(201)).body.message;
    assert.equal(message.sticker, 'blob:love');
    assert.equal(message.body, '');
    assert.equal((await send(alice, { sticker: 'emoji:😂' }).expect(201)).body.message.sticker, 'emoji:😂');
    await send(alice, { sticker: 'blob:nope' }).expect(422);
    await send(alice, { sticker: 'emoji:ab' }).expect(422);
    await send(alice, { sticker: 'blob:love', body: 'hi' }).expect(422);

    const conversation = (await request.get(`/api/conversations/${chat.id}`).set(auth(bob.token)).expect(200)).body.conversation;
    assert.equal(conversation.lastMessage.sticker, 'emoji:😂');

    // Stickers can't be edited; forwarding keeps them; "delete for everyone" erases them.
    await request.patch(`/api/messages/${message.id}`).set(auth(alice.token)).send({ body: 'changed' }).expect(400);
    const forwarded = (await request.post(`/api/messages/${message.id}/forward`).set(auth(bob.token)).send({ conversationIds: [chat.id] }).expect(201)).body;
    assert.equal(forwarded.messages[0].sticker, 'blob:love');
    await request.delete(`/api/messages/${message.id}?scope=everyone`).set(auth(alice.token)).expect(200);
    const history = (await request.get(`/api/conversations/${chat.id}/messages?limit=100`).set(auth(bob.token)).expect(200)).body.messages;
    assert.equal(history.find((m) => m.id === message.id).sticker, null);
  });

  test('my stickers: make one, only I can see the list, send it, and the other side can save it', async () => {
    const made = (await request.post('/api/stickers').set(auth(alice.token)).field('width', '512').field('height', '512').attach('image', PNG, 's.png').expect(201)).body.sticker;
    assert.equal(made.mimeType, 'image/png');
    assert.equal((await request.get(made.url).set(auth(alice.token)).expect(200)).headers['content-type'], 'image/png');
    await request.get(made.url).set(auth(bob.token)).expect(404);
    await request.post('/api/stickers').set(auth(alice.token)).attach('image', JPG, 'x.jpg').expect(415);

    const ready = (await request.post(`/api/stickers/${made.id}/send`).set(auth(alice.token)).send({ conversationId: chat.id }).expect(201)).body.attachment;
    assert.equal(ready.kind, 'sticker');
    await request.post(`/api/stickers/${made.id}/send`).set(auth(eve.token)).send({ conversationId: chat.id }).expect(404);
    // A sticker is the whole message.
    await send(alice, { attachmentIds: [ready.id], body: 'caption' }).expect(400);
    const message = (await send(alice, { attachmentIds: [ready.id] }).expect(201)).body.message;
    assert.equal(message.attachments[0].kind, 'sticker');

    // Bob saves it; Alice deleting hers doesn't break his (shared file).
    const saved = (await request.post('/api/stickers/save').set(auth(bob.token)).send({ attachmentId: message.attachments[0].id }).expect(201)).body.sticker;
    await request.post('/api/stickers/save').set(auth(eve.token)).send({ attachmentId: message.attachments[0].id }).expect(404);
    await request.delete(`/api/stickers/${made.id}`).set(auth(alice.token)).expect(204);
    await request.delete(`/api/stickers/${made.id}`).set(auth(alice.token)).expect(404);
    await request.get(saved.url).set(auth(bob.token)).expect(200);
    assert.equal((await request.get('/api/stickers').set(auth(bob.token)).expect(200)).body.stickers.length, 1);
    assert.equal((await request.get('/api/stickers').set(auth(alice.token)).expect(200)).body.stickers.length, 0);

    // Saving a normal photo as a sticker isn't possible.
    const photo = (await upload(alice, PNG, 'p.png').expect(201)).body.attachment;
    await request.post('/api/stickers/save').set(auth(alice.token)).send({ attachmentId: photo.id }).expect(404);
  });

  test('stickers can also be uploaded straight into a chat', async () => {
    const res = await upload(bob, PNG, 'mine.png', { kind: 'sticker' }).expect(201);
    assert.equal(res.body.attachment.kind, 'sticker');
    await upload(bob, JPG, 'mine.jpg', { kind: 'sticker' }).expect(415);
    await upload(bob, Buffer.concat([PNG, Buffer.alloc(600 * 1024)]), 'big.png', { kind: 'sticker' }).expect(413);
  });
});
