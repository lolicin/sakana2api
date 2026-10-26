import assert from 'node:assert/strict';
import test from 'node:test';
import context from '../lib/context.js';

const { ContextStore, firstUserText, lastUserText } = context;
const body = (id) => ({
  ...(id === undefined ? {} : { conversation_id: id }),
  messages: [{ role: 'user', content: 'shared first message' }],
});
function storeFor(t, options = {}) {
  const store = new ContextStore({ pruneIntervalMs: 0, ...options });
  t.after(() => store.close());
  return store;
}
function invalidId(fn) {
  assert.throws(fn, { status: 400, code: 'CONTEXT_ID_INVALID' });
}

test('matching first text never resolves a context without an explicit ID', (t) => {
  const store = storeFor(t);
  store.save({}, body(), 'conv-text', 'leaf', 'account');
  assert.equal(store.lookup({}, body()), null);
  assert.equal(store.lookup({}, { ...body(), model: 'sakana' }), null);
  assert.equal(store.getByConversationId('conv-text')?.lastMessageId, 'leaf');
  assert.equal(store.lookup({}, body('conv-text'))?.accountId, 'account');
});

test('an unknown explicit ID never falls through to matching text', (t) => {
  const store = storeFor(t);
  store.save({}, body('known'), 'conv-known', 'leaf');
  assert.equal(store.lookup({}, body('missing')), null);
  assert.equal(store.lookup({}, body()), null);
});

test('legacy string lookup always misses and string save is a no-op', (t) => {
  const store = storeFor(t);
  store.save('shared first message', undefined, 'conv-legacy', 'leaf');
  assert.equal(store.lookup('shared first message'), null);
  assert.equal(store.getByConversationId('conv-legacy'), null);
  assert.equal(store.size, 0);
  assert.equal(store.stats.sets, 0);
});

const aliasRequests = [
  [{}, { conversation_id: 'client' }],
  [{}, { chat_id: 'client' }],
  [{}, { thread_id: 'client' }],
  [{ headers: { 'x-conversation-id': 'client' } }, {}],
  [{ headers: { 'x-thread-id': 'client' } }, {}],
];
test('all supported explicit aliases resolve the owned context and upstream ID', (t) => {
  const store = storeFor(t);
  store.save({}, body('client'), 'conv-alias', 'leaf', 'account');
  assert.equal(typeof context.explicitContextId, 'function');
  for (const [req, payload] of aliasRequests) {
    assert.equal(context.explicitContextId(req, payload), 'client');
    assert.equal(store.lookup(req, payload)?.conversationId, 'conv-alias');
  }
  assert.equal(context.explicitContextId({}, {}), '');
  assert.equal(context.explicitContextId({ headers: { 'x-thread-id': 'header' } }, {
    conversation_id: 'body', chat_id: 'chat', thread_id: 'thread',
  }), 'body');
  assert.equal(store.lookup({}, body('conv-alias'))?.lastMessageId, 'leaf');
});

test('context keys contain only scoped explicit IDs', () => {
  assert.deepEqual(context.getContextKeys({}, body()), []);
  assert.deepEqual(context.getContextKeys('legacy text'), []);
  const a = context.getContextKeys({ contextScope: 'owner-a' }, body('client'));
  const b = context.getContextKeys({ contextScope: 'owner-b' }, body('client'));
  assert.equal(a.length, 1);
  assert.notDeepEqual(a, b);
  assert.deepEqual(a, context.getContextKeys({ contextScope: 'owner-a' }, {
    conversation_id: 'client', messages: [{ role: 'user', content: 'changed' }],
  }));
});

test('scope trusts the server override, then managed keys, and otherwise defaults to open', () => {
  assert.equal(typeof context.contextScope, 'function');
  assert.equal(context.contextScope({}), 'open');
  assert.equal(context.contextScope({ contextScope: 'trusted', keyId: 'managed', headers: { authorization: 'Bearer secret' } }), 'trusted');
  const managed = context.contextScope({ keyId: 'managed', headers: { authorization: 'Bearer secret' } });
  assert.equal(managed, context.contextScope({ keyId: 'managed', headers: { authorization: 'Bearer rotated' } }));
  assert.notEqual(managed, context.contextScope({ keyId: 'other' }));
  assert.notEqual(managed, context.contextScope({ headers: { authorization: 'Bearer managed' } }));
  assert.equal(context.contextScope({ headers: { 'x-session-scope': 'untrusted' }, user: 'untrusted' }), 'open');
});

test('credential transports share a SHA256 scope without exposing the token', (t) => {
  assert.equal(typeof context.contextScope, 'function');
  // SHA256('abc'), a hand-checked known digest.
  const hash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const requests = [
    { headers: { authorization: 'Bearer abc' } },
    { headers: { Authorization: 'bearer abc' } },
    { headers: { authorization: 'abc' } },
    ...['x-api-key', 'x-goog-api-key', 'api-key', 'goog-api-key'].map((name) => ({ headers: { [name]: 'abc' } })),
    { url: '/v1/models?key=%61bc' },
  ];
  const scope = context.contextScope(requests[0]);
  assert.ok(scope.endsWith(hash));
  assert.equal(scope.includes('abc'), false);
  for (const req of requests) assert.equal(context.contextScope(req), scope);
  const store = storeFor(t);
  store.save(requests[0], body('client'), 'conv-auth', 'leaf');
  for (const req of requests) assert.equal(store.lookup(req, body('client'))?.conversationId, 'conv-auth');
  assert.equal(store.lookup({ headers: { authorization: 'Bearer another' } }, body('client')), null);
  assert.equal(store.lookup({}, body('client')), null);
});

test('client session scope is bound to credentials and never replaces the credential owner', (t) => {
  const store = storeFor(t);
  const sharedScope = { headers: { 'x-api-key': 'shared-key', 'x-client-session-id': 'copied-scope' } };
  const otherScope = { headers: { 'x-api-key': 'other-key', 'x-client-session-id': 'copied-scope' } };
  assert.equal(context.contextScope(sharedScope), context.contextScope(sharedScope));
  assert.notEqual(context.contextScope(sharedScope), context.contextScope(otherScope));
  store.save(sharedScope, body('client-id'), 'conv-private', 'leaf-private');
  assert.equal(store.lookup(otherScope, body('client-id')), null);
  assert.equal(store.getByConversationId('conv-private', otherScope), null);
});

test('scoped aliases and upstream IDs isolate every read, list, update, and clear', (t) => {
  const store = storeFor(t);
  const a = { contextScope: 'owner-a' };
  const b = { contextScope: 'owner-b' };
  store.save(a, body('client'), 'conv-shared', 'leaf-a', 'account-a', { inputTokens: 10 });
  store.save(b, body('client'), 'conv-shared', 'leaf-b', 'account-b', { inputTokens: 20 });
  assert.equal(store.lookup(a, body('client'))?.scope, 'owner-a');
  assert.equal(store.lookup(b, body('conv-shared'))?.lastMessageId, 'leaf-b');
  assert.equal(store.getByConversationId('conv-shared'), null);
  assert.equal(store.updateLeaf('conv-shared', 'wrong'), 0);
  assert.equal(store.clearConversation('conv-shared'), 0);
  assert.equal(typeof store.list, 'function');
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.list(a).map((entry) => entry.accountId), ['account-a']);
  assert.deepEqual(store.list(b).map((entry) => entry.accountId), ['account-b']);
  assert.ok(store.updateLeaf('conv-shared', 'leaf-a2', { inputTokens: 15 }, a) > 0);
  assert.equal(store.getByConversationId('conv-shared', a)?.lastMessageId, 'leaf-a2');
  assert.equal(store.getByConversationId('conv-shared', b)?.lastMessageId, 'leaf-b');
  assert.equal(store.getByConversationId('conv-shared', b)?.inputTokens, 20);
  assert.ok(store.clearConversation('client', a) > 0);
  assert.equal(store.lookup(a, body('client')), null);
  assert.equal(store.getByConversationId('conv-shared', a), null);
  assert.equal(store.getByConversationId('conv-shared', b)?.accountId, 'account-b');
});

test('save and lookup obey managed-key ownership even for identical text and IDs', (t) => {
  const store = storeFor(t);
  store.save({ keyId: 'key-a' }, body('client'), 'conv-a', 'leaf-a');
  assert.equal(store.lookup({ keyId: 'key-b' }, body('client')), null);
  assert.equal(store.getByConversationId('conv-a', { keyId: 'key-b' }), null);
  store.save({ keyId: 'key-b' }, body('client'), 'conv-b', 'leaf-b');
  assert.equal(store.lookup({ keyId: 'key-a' }, body('client'))?.conversationId, 'conv-a');
  assert.equal(store.lookup({ keyId: 'key-b' }, body('client'))?.conversationId, 'conv-b');
});

test('saving a full branch under an old upstream ID preserves the original mapping', (t) => {
  const store = storeFor(t);
  const req = { contextScope: 'owner' };
  store.save(req, body('original-client'), 'conv-old', 'leaf-old', 'account-old', {
    firstMessageFingerprint: 'old-first', model: 'old-model', inputTokens: 100,
  });
  store.save(req, body('conv-old'), 'conv-new', 'leaf-new', 'account-new');
  assert.equal(store.lookup(req, body('conv-old'))?.conversationId, 'conv-old');
  assert.equal(store.lookup(req, body('original-client'))?.lastMessageId, 'leaf-old');
  const branch = store.getByConversationId('conv-new', req);
  assert.equal(branch?.lastMessageId, 'leaf-new');
  assert.equal(branch?.accountId, 'account-new');
  assert.equal(branch?.firstMessageFingerprint, '');
  assert.equal(branch?.model, undefined);
  assert.equal(branch?.inputTokens, undefined);
  assert.deepEqual(branch?.clientConversationIds, []);
});

test('a client alias cannot overwrite a separate conversation owner', (t) => {
  const store = storeFor(t);
  store.save({}, body('client'), 'conv-a', 'leaf-a');
  store.save({}, body('client'), 'conv-b', 'leaf-b');
  assert.equal(store.lookup({}, body('client'))?.conversationId, 'conv-a');
  assert.equal(store.lookup({}, body('conv-b'))?.lastMessageId, 'leaf-b');
  assert.deepEqual(store.getByConversationId('conv-b')?.clientConversationIds, []);
  assert.ok(store.clearConversation('conv-b') > 0);
  assert.equal(store.lookup({}, body('client'))?.lastMessageId, 'leaf-a');
});

test('adding an alias refreshes all retained aliases without losing snapshot fields', (t) => {
  const store = storeFor(t);
  store.save({}, body('client-1'), 'conv', 'leaf-1', 'account', {
    firstMessageFingerprint: 'first', recentClientHistoryFingerprint: 'history-1',
    recentUserFingerprint: 'user-1', messageCount: 2, model: 'sakana',
    inputTokens: 100, contextTokens: 130, forks: 1, rebuilds: 2,
  });
  store.save({}, body('client-2'), 'conv', 'leaf-2', null, {
    recentClientHistoryFingerprint: 'history-2', messageCount: 3, inputTokens: 150,
  });
  for (const id of ['client-1', 'client-2', 'conv']) {
    const entry = store.lookup({}, body(id));
    assert.equal(entry?.lastMessageId, 'leaf-2');
    assert.equal(entry?.accountId, 'account');
    assert.equal(entry?.recentClientHistoryFingerprint, 'history-2');
    assert.equal(entry?.firstMessageFingerprint, 'first');
    assert.equal(entry?.model, 'sakana');
    assert.equal(entry?.inputTokens, 150);
    assert.equal(entry?.contextTokens, 130);
  }
  assert.ok(store.updateLeaf('conv', 'leaf-3', { inputTokens: 180, contextTokens: 0 }) > 0);
  const entry = store.lookup({}, body('client-1'));
  assert.equal(entry?.lastMessageId, 'leaf-3');
  assert.equal(entry?.inputTokens, 180);
  assert.equal(entry?.contextTokens, 0);
  assert.equal(entry?.forks, 1);
  assert.equal(entry?.rebuilds, 2);
});

test('explicit aliases preserve all UTF8 bytes up to the 256-byte boundary', (t) => {
  const store = storeFor(t);
  for (const id of ['a'.repeat(256), 'é'.repeat(128), '😀'.repeat(64)]) {
    store.save({}, body(id), `conv-${id.length}`, 'leaf');
    assert.equal(store.lookup({}, body(id))?.clientConversationIds.includes(id), true);
  }
});

test('invalid IDs are rejected before lookup or save, never coerced or clipped', (t) => {
  const store = storeFor(t);
  store.save({}, body('valid'), 'conv-valid', 'leaf');
  const invalid = [null, 7, false, [], {}, '', '   ', 'a\nb', 'a\0b', 'a\u007fb', 'a\u0085b', 'a'.repeat(257), 'é'.repeat(129), '😀'.repeat(65)];
  for (const id of invalid) {
    invalidId(() => store.lookup({}, body(id)));
    invalidId(() => store.save({}, body(id), 'conv-invalid', 'leaf'));
  }
  invalidId(() => store.lookup({ headers: { 'x-thread-id': ['valid'] } }, {}));
  invalidId(() => store.lookup({}, { conversation_id: '', chat_id: 'valid' }));
  invalidId(() => store.lookup({ headers: { 'x-thread-id': 'bad\n' } }, { conversation_id: 'valid' }));
  assert.equal(store.getByConversationId('conv-invalid'), null);
  assert.equal(store.lookup({}, body('valid'))?.lastMessageId, 'leaf');
});

test('snapshot aliases also reject invalid IDs without partially saving', (t) => {
  const store = storeFor(t);
  invalidId(() => store.save({}, body('valid'), 'conv', 'leaf', null, { clientConversationIds: ['bad\n'] }));
  assert.equal(store.size, 0);
});

test('leaf updates and scoped listing tolerate malformed entries', (t) => {
  const store = storeFor(t);
  store.save({}, body('client'), 'conv', 'leaf');
  store.map.set('malformed', null);
  assert.ok(store.updateLeaf('conv', 'next') > 0);
  assert.equal(store.lookup({}, body('client'))?.lastMessageId, 'next');
  assert.equal(typeof store.list, 'function');
  assert.deepEqual(store.list().map((entry) => entry.conversationId), ['conv']);
});

test('user text helpers skip tool turns without creating lookup keys', () => {
  const payload = { messages: [
    { role: 'user', content: [{ text: 'base question' }] },
    { role: 'assistant', tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'result' },
  ] };
  assert.equal(firstUserText(payload), 'base question');
  assert.equal(lastUserText(payload), 'base question');
  assert.deepEqual(context.getContextKeys({}, payload), []);
});
