import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextStore } from '../lib/context.js';

const body = (id, text = 'same') => ({ conversation_id: id, messages: [{ role: 'user', content: text }] });
function storeFor(t, options = {}) {
  const store = new ContextStore({ pruneIntervalMs: 0, ...options });
  t.after(() => store.close());
  return store;
}

test('alias cap removes evicted keys even when their first user text still matches', (t) => {
  let now = 1000;
  const store = storeFor(t, { ttl: 100, capacity: 30, maxClientAliases: 2, now: () => now });
  const req = { contextScope: 'owner' };
  for (let i = 1; i <= 20; i++) {
    now++;
    store.save(req, body(`client-${i}`), 'conv', `leaf-${i}`);
  }
  const entry = store.getByConversationId('conv', req);
  assert.deepEqual(entry?.clientConversationIds, ['client-19', 'client-20']);
  assert.equal(store.lookup(req, body('client-1')), null);
  assert.equal(store.lookup(req, body('client-18')), null);
  assert.equal(store.lookup(req, body('client-19'))?.lastMessageId, 'leaf-20');
  assert.equal(store.lookup(req, body('client-20', 'different'))?.lastMessageId, 'leaf-20');
  assert.equal(store.lookup(req, body('conv'))?.lastMessageId, 'leaf-20');
  assert.ok(store.size <= 3, 'only two aliases and the scoped upstream ID are retained');
});

test('zero client aliases retains only the scoped upstream ID', (t) => {
  const store = storeFor(t, { maxClientAliases: 0 });
  store.save({}, body('client'), 'conv', 'leaf');
  assert.deepEqual(store.getByConversationId('conv')?.clientConversationIds, []);
  assert.equal(store.lookup({}, body('client')), null);
  assert.equal(store.lookup({}, body('conv'))?.lastMessageId, 'leaf');
  assert.equal(store.size, 1);
});

test('alias pruning affects only its own scope', (t) => {
  const store = storeFor(t, { maxClientAliases: 1 });
  const a = { contextScope: 'a' };
  const b = { contextScope: 'b' };
  store.save(a, body('client-1'), 'conv', 'a1');
  store.save(b, body('client-1'), 'conv', 'b1');
  store.save(a, body('client-2'), 'conv', 'a2');
  assert.equal(store.lookup(a, body('client-1')), null);
  assert.equal(store.lookup(b, body('client-1'))?.lastMessageId, 'b1');
  assert.equal(store.lookup(a, body('client-2'))?.lastMessageId, 'a2');
});

test('TTL expiry rejects reads and leaf updates without reviving stale state', (t) => {
  let now = 1000;
  const store = storeFor(t, { ttl: 10, now: () => now });
  store.save({}, body('client'), 'conv', 'leaf');
  now = 1009;
  assert.equal(store.lookup({}, body('client'))?.lastMessageId, 'leaf');
  now = 1010;
  assert.equal(store.updateLeaf('conv', 'too-late'), 0);
  assert.equal(store.getByConversationId('conv'), null);
  assert.equal(store.lookup({}, body('client')), null);
  assert.equal(typeof store.list, 'function');
  assert.deepEqual(store.list(), []);
});

test('prune, expire, capacity, and close retain deterministic cleanup behavior', (t) => {
  let now = 1000;
  const pruned = [];
  const store = storeFor(t, { ttl: 10, capacity: 3, now: () => now, onPrune: (count) => pruned.push(count) });
  for (let i = 0; i < 4; i++) {
    store.save({}, {}, `conv-${i}`, `leaf-${i}`);
    now++;
  }
  assert.equal(store.size, 3);
  assert.equal(store.getByConversationId('conv-0'), null);
  assert.equal(store.getByConversationId('conv-3')?.lastMessageId, 'leaf-3');
  assert.ok(pruned.length > 0);
  now += 10;
  assert.equal(store.prune(), 3);
  assert.equal(store.size, 0);
  store.save({}, {}, 'conv-expire', 'leaf');
  now += 10;
  assert.equal(store.expire(), 1);
  store.save({}, {}, 'conv-close', 'leaf');
  store.close();
  assert.equal(store.size, 0);
});

test('capacity remains bounded across repeated scoped alias registrations', (t) => {
  let now = 1000;
  const store = storeFor(t, { capacity: 5, maxClientAliases: 2, now: () => now });
  for (let i = 0; i < 20; i++) {
    now++;
    store.save({ contextScope: `owner-${i % 3}` }, body(`client-${i}`), `conv-${i}`, `leaf-${i}`);
    assert.ok(store.size <= 5);
  }
  assert.equal(store.lookup({ contextScope: 'owner-1' }, body('client-19'))?.lastMessageId, 'leaf-19');
  assert.equal(store.lookup({ contextScope: 'owner-1' }, body('client-1')), null);
});

test('list returns only live unique contexts within the requested scope', (t) => {
  let now = 1000;
  const store = storeFor(t, { ttl: 10, now: () => now });
  const a = { contextScope: 'a' };
  const b = { contextScope: 'b' };
  store.save(a, body('old-client'), 'old', 'leaf');
  now = 1005;
  store.save(a, body('client-1'), 'live', 'leaf');
  store.save(a, body('client-2'), 'live', 'leaf');
  store.save(b, body('client-1'), 'private', 'leaf');
  now = 1010;
  assert.equal(typeof store.list, 'function');
  assert.deepEqual(store.list(a).map((entry) => entry.conversationId), ['live']);
  assert.deepEqual(store.list(b).map((entry) => entry.conversationId), ['private']);
  assert.deepEqual(store.list(), []);
});

test('expired alias ownership can be reclaimed by a fresh context', (t) => {
  let now = 1000;
  const store = storeFor(t, { ttl: 10, now: () => now });
  store.save({}, body('client'), 'old', 'leaf-old');
  now += 10;
  store.save({}, body('client'), 'new', 'leaf-new');
  assert.equal(store.lookup({}, body('client'))?.conversationId, 'new');
  assert.equal(store.getByConversationId('old'), null);
});

test('the periodic pruner expires scoped contexts and stops on close', async (t) => {
  let now = 1000;
  const store = storeFor(t, { ttl: 10, now: () => now });
  store.save({ contextScope: 'owner' }, body('client'), 'conv', 'leaf');
  now += 10;
  assert.equal(store.startPruner(5), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(store.size, 0);
  assert.equal(store.stopPruner(), true);
  assert.equal(store.startPruner(0), false);
  assert.equal(store.startPruner(5), true);
  store.close();
  assert.equal(store.stopPruner(), false);
});
