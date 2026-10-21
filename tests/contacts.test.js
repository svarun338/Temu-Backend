import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { auth, closeAll, registerUser, resetDatabase, startServer } from './helpers.js';

let server;
let request;
let alice;
let bob;
let carol;

before(async () => {
  await resetDatabase();
  server = await startServer();
  request = server.request;
  alice = await registerUser(request, { name: 'Alice Smith', email: 'alice@example.com' });
  bob = await registerUser(request, { name: 'Bob Jones', email: 'bob@example.com' });
  carol = await registerUser(request, { name: 'Carol 100%_ Real', email: 'carol@example.com' });
});

after(async () => {
  await server.close();
  await closeAll();
});

describe('user search', () => {
  test('finds users by name or full email and excludes yourself', async () => {
    const byName = await request.get('/api/users/search?q=bob').set(auth(alice.token)).expect(200);
    assert.deepEqual(byName.body.users.map((u) => u.id), [bob.user.id]);
    assert.equal(byName.body.users[0].isContact, false);
    // Bob hasn't saved Alice, so she doesn't get his email.
    assert.equal(byName.body.users[0].email, null);

    // Only the complete address matches: no harvesting emails letter by letter.
    const partial = await request.get('/api/users/search?q=carol@').set(auth(alice.token)).expect(200);
    assert.equal(partial.body.users.length, 0);
    const byEmail = await request.get('/api/users/search?q=CAROL@example.com').set(auth(alice.token)).expect(200);
    assert.equal(byEmail.body.users[0].id, carol.user.id);

    const self = await request.get('/api/users/search?q=alice').set(auth(alice.token)).expect(200);
    assert.equal(self.body.users.length, 0);
  });

  test('treats LIKE wildcards literally', async () => {
    const res = await request.get('/api/users/search?q=%25_').set(auth(alice.token)).expect(200);
    assert.deepEqual(res.body.users.map((u) => u.id), [carol.user.id]);
    const none = await request.get('/api/users/search?q=__').set(auth(alice.token)).expect(200);
    assert.equal(none.body.users.length, 0);
  });

  test('is safe against SQL injection payloads', async () => {
    const res = await request
      .get(`/api/users/search?q=${encodeURIComponent("' OR '1'='1")}`)
      .set(auth(alice.token))
      .expect(200);
    assert.equal(res.body.users.length, 0);
  });

  test('requires at least 2 characters', async () => {
    await request.get('/api/users/search?q=a').set(auth(alice.token)).expect(422);
  });
});

describe('contacts', () => {
  test('add, list and see the contact flag in search', async () => {
    const res = await request.post('/api/contacts').set(auth(alice.token)).send({ userId: bob.user.id }).expect(201);
    assert.equal(res.body.contact.id, bob.user.id);
    assert.equal(res.body.contact.name, 'Bob Jones');

    // Adding again is idempotent.
    await request.post('/api/contacts').set(auth(alice.token)).send({ userId: bob.user.id }).expect(200);

    const list = await request.get('/api/contacts').set(auth(alice.token)).expect(200);
    assert.deepEqual(list.body.contacts.map((c) => c.id), [bob.user.id]);

    const search = await request.get('/api/users/search?q=bob').set(auth(alice.token)).expect(200);
    assert.equal(search.body.users[0].isContact, true);

    // Contacts are one-directional: Bob's list is still empty.
    const bobList = await request.get('/api/contacts').set(auth(bob.token)).expect(200);
    assert.equal(bobList.body.contacts.length, 0);
  });

  test('cannot add yourself or a missing user', async () => {
    await request.post('/api/contacts').set(auth(alice.token)).send({ userId: alice.user.id }).expect(400);
    await request.post('/api/contacts').set(auth(alice.token)).send({ userId: 999999 }).expect(404);
    await request.post('/api/contacts').set(auth(alice.token)).send({ userId: 'abc' }).expect(422);
  });

  test('remove a contact', async () => {
    await request.post('/api/contacts').set(auth(alice.token)).send({ userId: carol.user.id }).expect(201);
    await request.delete(`/api/contacts/${carol.user.id}`).set(auth(alice.token)).expect(204);
    await request.delete(`/api/contacts/${carol.user.id}`).set(auth(alice.token)).expect(404);
    const list = await request.get('/api/contacts').set(auth(alice.token)).expect(200);
    assert.ok(!list.body.contacts.some((c) => c.id === carol.user.id));
  });

  test("removing someone else's contact entry is impossible", async () => {
    // Bob tries to delete Alice -> Bob (which belongs to Alice); only his own list is targeted.
    await request.delete(`/api/contacts/${bob.user.id}`).set(auth(bob.token)).expect(404);
    const list = await request.get('/api/contacts').set(auth(alice.token)).expect(200);
    assert.ok(list.body.contacts.some((c) => c.id === bob.user.id));
  });
});
