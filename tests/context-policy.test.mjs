import assert from 'node:assert/strict';
import test from 'node:test';
import policy from '../lib/context-policy.js';
import context from '../lib/context.js';

const { ContextStore } = context;
const messages = [
  { role: 'user', parts: [{ kind: 'text', text: 'hello' }] },
  { role: 'assistant', parts: [{ kind: 'text', text: 'hi' }] },
];
const snapshot = policy.makeContextSnapshot({ messages });
const stored = { conversationId: 'conv-1', lastMessageId: 'msg-1', ...snapshot };
const fresh = { action: 'new', reason: 'FULL_HISTORY' };
const expired = { action: 'error', reason: 'CONTEXT_EXPIRED' };

test('full history is the default even with a known explicit ID or identical snapshot', () => {
  for (const options of [
    {}, { client: snapshot }, { stored, client: snapshot },
    { explicitId: 'conv-1', stored, client: snapshot },
    { explicitId: 'missing', stored: null, rebuildAttempted: true },
    { stored, client: { ...snapshot, messageCount: 1 } },
    { stored, client: { ...snapshot, firstMessageFingerprint: 'different' } },
  ]) assert.deepEqual(policy.decideContext(options), fresh);
});

test('explicit full always creates a new context regardless of stored history or model', () => {
  for (const options of [
    { historyMode: 'full' }, { history_mode: 'full' }, { mode: 'full' },
    { client: { historyMode: 'full' } },
    { explicitId: 'conv-1', stored, client: snapshot, historyMode: 'full' },
    { explicitId: 'unrelated', stored, historyMode: 'full' },
    { explicitId: 'conv-1', stored: { ...stored, model: 'old' }, client: { model: 'new' }, historyMode: 'full' },
  ]) assert.deepEqual(policy.decideContext(options), fresh);
});

test('delta without an explicit ID returns CONTEXT_ID_REQUIRED even if history matches', () => {
  for (const options of [
    { historyMode: 'delta' }, { history_mode: 'delta', stored, client: snapshot },
    { mode: 'delta', stored }, { client: { ...snapshot, historyMode: 'delta' }, stored },
  ]) assert.deepEqual(policy.decideContext(options), { action: 'error', reason: 'CONTEXT_ID_REQUIRED' });
});

test('missing, expired, or mismatched delta mappings return CONTEXT_EXPIRED without rebuilding', () => {
  for (const options of [
    { explicitId: 'missing' },
    { explicitId: 'missing', rebuildAttempted: true },
    { explicitId: 'other', stored },
    { explicitId: 'client-1', stored: { ...stored, clientConversationIds: ['client-2'] } },
  ]) assert.deepEqual(policy.decideContext({ ...options, historyMode: 'delta' }), expired);
});

test('delta reuses only the exact upstream ID or a registered client alias', () => {
  const expected = { action: 'reuse', conversationId: 'conv-1', lastMessageId: 'msg-1', sendClientHistory: false };
  assert.deepEqual(policy.decideContext({ explicitId: 'conv-1', stored, historyMode: 'delta' }), expected);
  assert.deepEqual(policy.decideContext({
    explicitId: 'client-1', stored: { ...stored, clientConversationIds: ['client-1'] },
    client: { ...snapshot, firstMessageFingerprint: 'new-turn', messageCount: 1 }, history_mode: 'delta',
  }), expected);
});

test('delta rejects differing nonempty model keys', () => {
  assert.deepEqual(policy.decideContext({
    explicitId: 'conv-1', stored: { ...stored, model: 'sakana-a' },
    client: { ...snapshot, model: 'sakana-b' }, historyMode: 'delta',
  }), { action: 'error', reason: 'CONTEXT_MODEL_MISMATCH' });
  for (const [savedModel, model] of [['sakana', 'sakana'], ['', 'sakana'], ['sakana', ''], [undefined, undefined]]) {
    assert.equal(policy.decideContext({
      explicitId: 'conv-1', stored: { ...stored, model: savedModel },
      client: { model }, historyMode: 'delta',
    }).action, 'reuse');
  }
});

test('delta lookup uses ownership across each supported explicit ID transport', () => {
  assert.equal(typeof context.explicitContextId, 'function');
  const { explicitContextId } = context;
  const store = new ContextStore({ pruneIntervalMs: 0 });
  try {
    store.save({ keyId: 'owner' }, { conversation_id: 'client' }, 'conv', 'leaf', 'account');
    const requests = [
      [{ keyId: 'owner' }, { conversation_id: 'client' }],
      [{ keyId: 'owner' }, { chat_id: 'client' }],
      [{ keyId: 'owner' }, { thread_id: 'client' }],
      [{ keyId: 'owner', headers: { 'x-conversation-id': 'client' } }, {}],
      [{ keyId: 'owner', headers: { 'x-thread-id': 'client' } }, {}],
    ];
    for (const [req, payload] of requests) {
      assert.equal(policy.decideContext({
        explicitId: explicitContextId(req, payload), stored: store.lookup(req, payload), history_mode: 'delta',
      }).action, 'reuse');
      assert.deepEqual(policy.decideContext({
        explicitId: explicitContextId(req, payload), stored: store.lookup({ ...req, keyId: 'stranger' }, payload), history_mode: 'delta',
      }), expired);
    }
  } finally { store.close(); }
});

test('fingerprints canonicalize object keys while retaining ordered message content', () => {
  const a = [{ role: 'assistant', tool_calls: [{ function: { arguments: { b: 2, a: 1 }, name: 'f' }, id: 'call' }] }];
  const b = [{ tool_calls: [{ id: 'call', function: { name: 'f', arguments: { a: 1, b: 2 } } }], role: 'assistant' }];
  assert.equal(policy.messageFingerprint(a), policy.messageFingerprint(b));
  assert.notEqual(policy.messageFingerprint(messages), policy.messageFingerprint([...messages].reverse()));
});

test('snapshots fingerprint the complete canonical history rather than hints or a recent tail', () => {
  const history = [
    { role: 'system', parts: [{ kind: 'text', text: 'original instruction' }] },
    ...Array.from({ length: 12 }, (_, i) => ({ role: 'user', parts: [{ kind: 'text', text: `turn-${i}` }] })),
  ];
  const first = policy.makeContextSnapshot({ messages: history, fingerprint: 'stale', recentHistoryFingerprint: 'stale' });
  const edited = policy.makeContextSnapshot({
    messages: history.map((message, i) => i === 0 ? { ...message, parts: [{ kind: 'text', text: 'edited instruction' }] } : message),
    fingerprint: 'stale', recentHistoryFingerprint: 'stale',
  });
  assert.notEqual(first.recentClientHistoryFingerprint, edited.recentClientHistoryFingerprint);
  assert.notEqual(first.recentClientHistoryFingerprint, 'stale');
  const changedUser = policy.makeContextSnapshot({ messages: history.map((message, i) => i === 2
    ? { ...message, parts: [{ kind: 'text', text: 'edited early user turn' }] } : message) });
  assert.notEqual(first.recentUserFingerprint, changedUser.recentUserFingerprint);
  assert.equal(first.messageCount, 13);
  assert.equal(typeof first.updatedAt, 'number');
});

test('snapshots retain optional model and cumulative token measurements', () => {
  const result = policy.makeContextSnapshot({ messages, model: 'sakana', inputTokens: 120, contextTokens: 160 });
  assert.equal(result.model, 'sakana');
  assert.equal(result.inputTokens, 120);
  assert.equal(result.contextTokens, 160);
  assert.equal(policy.makeContextSnapshot({ messages }).inputTokens, undefined);
});

test('known history requires the exact full fingerprint rather than matching counts or user turns', () => {
  assert.equal(policy.isKnownHistory(stored, snapshot), true);
  for (const client of [
    { firstMessageFingerprint: snapshot.firstMessageFingerprint, messageCount: 3 },
    { ...snapshot, messageCount: 3, recentClientHistoryFingerprint: 'different' },
    { ...snapshot, recentClientHistoryFingerprint: 'edited-assistant' },
    { ...snapshot, recentClientHistoryFingerprint: '' },
  ]) assert.equal(policy.isKnownHistory(stored, client), false);
});
