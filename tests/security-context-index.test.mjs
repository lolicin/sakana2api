import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ContextStore, contextScope } = require('../lib/context.js');
const root = mkdtempSync(path.join(os.tmpdir(), 'sakana-context-capacity-'));
try {
  const store = new ContextStore({ capacity: 4, pruneIntervalMs: 0 });
  const owner = { keyId: 'tenant-a' };
  const firstBody = { conversation_id: 'client-a' };
  const secondBody = { conversation_id: 'client-b' };
  const thirdBody = { conversation_id: 'client-c' };
  store.save(owner, firstBody, 'upstream-a', 'leaf-a', 'account-a', { model: 'sakana', messageCount: 0 });
  store.save(owner, secondBody, 'upstream-b', 'leaf-b', 'account-a', { model: 'sakana', messageCount: 0 });
  assert.equal(store.size, 4, 'two complete contexts use their upstream keys and client aliases');
  store.save(owner, thirdBody, 'upstream-c', 'leaf-c', 'account-a', { model: 'sakana', messageCount: 0 });
  assert.equal(store.size, 4, 'capacity eviction removes the oldest conversation alias group atomically');
  assert.equal(store.lookup(owner, firstBody), null, 'evicted contexts lose every alias together');
  assert.equal(store.getByConversationId('upstream-a', owner), null, 'an evicted upstream ID cannot survive independently');
  assert.equal(store.lookup(owner, secondBody)?.conversationId, 'upstream-b');
  assert.equal(store.lookup(owner, thirdBody)?.conversationId, 'upstream-c');
  assert.equal(contextScope(owner), 'key:tenant-a');
  store.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log('context index integrity tests: all passed');
