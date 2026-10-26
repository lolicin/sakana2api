import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import {
  ADMIN_KEY, MANAGED_A, MANAGED_B, SHARED_KEY,
  markers, startContextIsolationFixture,
} from './helpers/context-isolation-http.mjs';

const credentials = [
  { name: 'managed A', key: MANAGED_A, header: 'x-api-key' },
  { name: 'managed B with the same display name', key: MANAGED_B, header: 'x-goog-api-key' },
  { name: 'static API key', key: SHARED_KEY, header: 'api-key' },
  { name: 'static admin key', key: ADMIN_KEY, header: 'x-api-key' },
];

function ok(result, label = 'chat') {
  assert.equal(result.status, 200, `${label}: ${result.text}`);
  assert.equal(result.json.error, undefined, `${label} returned an error in a 200 response`);
  return result;
}

function chatText(result) {
  return result.json.choices?.[0]?.message?.content || '';
}

function ownMarkers(text, expected, label) {
  assert.deepEqual(markers(text), [...expected].sort(), `${label} must contain all and only this client's markers`);
}

function expired(result, label) {
  assert.equal(result.status, 409, `${label}: ${result.text}`);
  assert.equal(result.json.error?.code, 'CONTEXT_EXPIRED', `${label} returns a stable context-expired code`);
}

function listIds(result) {
  ok(result, 'list conversations');
  const entries = Array.isArray(result.json) ? result.json : result.json.conversations || result.json.data;
  assert.ok(Array.isArray(entries), 'conversation list exposes an array');
  return entries.map((entry) => entry.conversationId || entry.conversation_id || entry.id).sort();
}

// These tests exercise the running HTTP server, not ContextStore internals.
// Every upstream side effect is recorded by a localhost protocol fixture.
// In particular, a wrong parent really loses prior messages in that fixture.
describe('HTTP conversation context isolation', { concurrency: false }, () => {
  let fixture;
  before(async () => { fixture = await startContextIsolationFixture(); });
  after(async () => { await fixture?.close(); });
  afterEach(() => { assert.deepEqual(fixture.state.errors, [], 'fake upstream accepted the real wire protocol'); });

  async function seed(marker, key = SHARED_KEY, model = 'sakana-namazu') {
    const start = fixture.state.generations.length;
    const result = ok(await fixture.chat({ model, messages: [{ role: 'user', content: marker }] }, { key }), 'initial full history');
    const generation = fixture.state.generations.slice(start).find((turn) => turn.conversationId === result.json.conversation_id);
    assert.ok(generation, 'initial full history generated upstream');
    assert.equal(result.json.conversation_id, generation.conversationId, 'client receives the raw upstream conversation ID');
    ownMarkers(chatText(result), [marker], 'initial response');
    return { id: result.json.conversation_id, result, generation };
  }

  test('identical first user text never reuses context without an ID, even on one shared key', async () => {
    const greeting = 'Hello, please help me with my writing and programming.';
    const first = ok(await fixture.chat({ messages: [{ role: 'user', content: greeting }] }));
    const second = ok(await fixture.chat({ messages: [{ role: 'user', content: greeting }] }));
    const third = ok(await fixture.chat({ messages: [
      { role: 'user', content: greeting },
      { role: 'assistant', content: 'How can I help?' },
      { role: 'user', content: 'CTX_SAME_GREETING_NEW_PERSON' },
    ] }));
    assert.equal(new Set([first, second, third].map((reply) => reply.json.conversation_id)).size, 3,
      'same-key people with identical greetings each get a fresh upstream conversation');
    ownMarkers(chatText(third), ['CTX_SAME_GREETING_NEW_PERSON'], 'new person response');
  });

  for (const historyMode of [undefined, 'full']) {
    for (const placement of ['body', 'header']) {
      test(`${historyMode || 'default'} full history always starts fresh with an owned ${placement} ID`, async () => {
        const prefix = `CTX_FULL_${historyMode ? 'EXPLICIT' : 'DEFAULT'}_${placement.toUpperCase()}`;
        const first = await seed(`${prefix}_FIRST`);
        const start = fixture.state.generations.length;
        const result = ok(await fixture.chat({
          ...(historyMode ? { history_mode: historyMode } : {}),
          ...(placement === 'body' ? { conversation_id: first.id } : {}),
          messages: [
            { role: 'user', content: `${prefix}_FIRST` },
            { role: 'assistant', content: chatText(first.result) },
            { role: 'user', content: `${prefix}_SECOND` },
          ],
        }, { headers: placement === 'header' ? { 'x-conversation-id': first.id } : {} }));
        const generation = fixture.state.generations[start];
        assert.notEqual(result.json.conversation_id, first.id, 'full history cannot append to an existing upstream conversation');
        assert.equal(result.json.conversation_id, generation.conversationId, 'full reply identifies its new raw upstream conversation');
        ownMarkers(generation.source, [`${prefix}_FIRST`, `${prefix}_SECOND`], 'full upstream source');
        ownMarkers(chatText(result), [`${prefix}_FIRST`, `${prefix}_SECOND`], 'full response');
      });
    }
  }

  test('reusing a client-supplied ID in full mode still creates a fresh upstream conversation', async () => {
    const alias = 'client-invented-full-id';
    const ids = [];
    for (let index = 0; index < 2; index++) {
      const marker = `CTX_FULL_UNREGISTERED_ID_${index}`;
      const start = fixture.state.generations.length;
      const full = ok(await fixture.chat({
        conversation_id: alias,
        messages: [{ role: 'user', content: marker }],
      }));
      assert.notEqual(full.json.conversation_id, alias, 'full history returns a newly created upstream ID');
      assert.equal(full.json.conversation_id, fixture.state.generations[start].conversationId);
      ownMarkers(chatText(full), [marker], 'full history with a repeated client ID');
      ids.push(full.json.conversation_id);
    }
    assert.equal(new Set(ids).size, 2, 'an explicit full-history ID never causes upstream reuse');
  });

  test('100 same-key people retain their own novel and programming secrets over two concurrent full-history rounds', async () => {
    const clients = Array.from({ length: 100 }, (_, index) => {
      const id = String(index).padStart(3, '0');
      return {
        novel: `CTX_PERSON_${id}_NOVEL_SECRET`,
        program: `CTX_PERSON_${id}_PROGRAMMING_SECRET`,
        roundTwo: `CTX_PERSON_${id}_ROUND_TWO`,
      };
    });
    const firstHistory = (client) => [
      { role: 'user', content: 'Hello! Can you help me today?' },
      { role: 'assistant', content: 'Yes, tell me about your projects.' },
      { role: 'user', content: `My novel's private phrase is ${client.novel}. My program's secret constant is ${client.program}. Remember both.` },
    ];
    const firstStart = fixture.state.generations.length;
    fixture.state.resetConcurrency();
    const first = await Promise.all(clients.map((client) => fixture.chat({ messages: firstHistory(client) })));
    first.forEach((result, index) => {
      ok(result, `person ${index}, round one`);
      ownMarkers(chatText(result), [clients[index].novel, clients[index].program], `person ${index}, round one reply`);
    });
    const firstIds = first.map((result) => result.json.conversation_id);
    assert.equal(new Set(firstIds).size, 100, 'round one has 100 distinct upstream conversations');
    assert.ok(fixture.state.maxActiveGenerations > 1, 'independent clients actually overlap upstream');
    const firstById = new Map(fixture.state.generations.slice(firstStart).map((generation) => [generation.conversationId, generation]));
    for (let index = 0; index < clients.length; index++) {
      ownMarkers(firstById.get(firstIds[index])?.source, [clients[index].novel, clients[index].program], `person ${index}, round one submitted source`);
    }

    const secondStart = fixture.state.generations.length;
    const second = await Promise.all(clients.map((client, index) => fixture.chat({ messages: [
      ...firstHistory(client),
      { role: 'assistant', content: chatText(first[index]) },
      { role: 'user', content: `Continue my novel and debug my program. This is ${client.roundTwo}.` },
    ] })));
    const secondById = new Map(fixture.state.generations.slice(secondStart).map((generation) => [generation.conversationId, generation]));
    second.forEach((result, index) => {
      ok(result, `person ${index}, round two`);
      const expected = [clients[index].novel, clients[index].program, clients[index].roundTwo];
      ownMarkers(chatText(result), expected, `person ${index}, round two reply`);
      ownMarkers(secondById.get(result.json.conversation_id)?.source, expected, `person ${index}, round two submitted full source`);
    });
    assert.equal(new Set([...firstIds, ...second.map((result) => result.json.conversation_id)]).size, 200,
      'all 200 full-history calls create independent conversations across both rounds');
  });

  test('explicit delta without an ID is rejected before any upstream call', async () => {
    const before = fixture.state.calls.length;
    const result = await fixture.chat({
      history_mode: 'delta', messages: [{ role: 'user', content: 'CTX_DELTA_REQUIRES_OWNED_ID' }],
    });
    assert.ok(result.status === 400 || result.status === 409, `missing delta ID must be rejected: ${result.text}`);
    assert.ok(result.json.error, 'missing delta ID returns an error');
    assert.equal(fixture.state.calls.length, before, 'delta without an ID never retries with fresh history');
  });

  for (const input of [
    { label: 'unknown ID', fields: { conversation_id: 'unknown-delta-conversation' } },
    { label: 'upstream ID never registered by the proxy', fields: { conversation_id: 'upstream-unregistered' } },
  ]) {
    test(`explicit delta rejects ${input.label} with CONTEXT_EXPIRED before upstream`, async () => {
      const before = fixture.state.calls.length;
      const result = await fixture.chat({
        history_mode: 'delta', ...input.fields,
        messages: [{ role: 'user', content: 'CTX_DELTA_REQUIRES_OWNED_ID' }],
      });
      expired(result, input.label);
      assert.equal(fixture.state.calls.length, before, 'invalid delta does not inspect, generate, or bootstrap upstream');
    });
  }

  for (const [index, owner] of credentials.entries()) {
    test(`${owner.name} can continue a registered raw ID using header-only context and another auth header`, async () => {
      const initial = await seed(`CTX_OWNER_${index}_FIRST`, owner.key);
      const start = fixture.state.generations.length;
      const result = ok(await fixture.chat({
        history_mode: 'delta', messages: [{ role: 'user', content: `CTX_OWNER_${index}_SECOND` }],
      }, { key: null, headers: { [owner.header]: owner.key, 'x-conversation-id': initial.id } }));
      assert.equal(result.json.conversation_id, initial.id, 'a delta keeps the raw upstream ID');
      const turn = fixture.state.generations[start];
      assert.equal(turn.conversationId, initial.id);
      assert.equal(turn.data.id, initial.generation.assistantMessageId, 'registered delta starts from the completed assistant leaf');
      ownMarkers(turn.source, [`CTX_OWNER_${index}_SECOND`], 'delta submits only its new turn');
      ownMarkers(chatText(result), [`CTX_OWNER_${index}_FIRST`, `CTX_OWNER_${index}_SECOND`], 'delta response retains its owned history');
    });

    test(`${owner.name}'s conversation is unavailable to every other request scope`, async () => {
      const initial = await seed(`CTX_SCOPE_${index}_PRIVATE`, owner.key);
      const results = [];
      for (const foreign of credentials.filter((candidate) => candidate.key !== owner.key)) {
        const before = fixture.state.calls.length;
        const result = await fixture.chat({
          history_mode: 'delta', conversation_id: initial.id,
          messages: [{ role: 'user', content: `CTX_SCOPE_${index}_FOREIGN_REQUEST` }],
        }, { key: foreign.key });
        results.push({ foreign, result, upstreamCalls: fixture.state.calls.length - before });
      }
      for (const { foreign, result, upstreamCalls } of results) {
        expired(result, `${foreign.name} continuing ${owner.name}'s ID`);
        assert.equal(upstreamCalls, 0, 'foreign delta never reaches upstream, even with a known raw ID');
      }
    });
  }

  test('a copied client session header cannot cross credentials, while the same owner can continue', async () => {
    const scope = 'shared-browser-session-identifier';
    const headers = { 'x-client-session-id': scope };
    const first = ok(await fixture.chat({ messages: [{ role: 'user', content: 'CTX_CLIENT_SCOPE_OWNER' }] }, {
      key: SHARED_KEY, headers,
    }));
    const initial = { id: first.json.conversation_id };
    const firstTurn = ok(await fixture.chat({ history_mode: 'delta', messages: [{ role: 'user', content: 'CTX_CLIENT_SCOPE_OWNER_TURN' }] }, {
      key: SHARED_KEY, headers: { ...headers, 'x-conversation-id': initial.id },
    }));
    assert.equal(firstTurn.json.conversation_id, initial.id);
    const foreignCalls = fixture.state.calls.length;
    const foreign = await fixture.chat({ history_mode: 'delta', messages: [{ role: 'user', content: 'CTX_CLIENT_SCOPE_FOREIGN_TURN' }] }, {
      key: MANAGED_A, headers: { ...headers, 'x-conversation-id': initial.id },
    });
    expired(foreign, 'copied client scope with a different credential');
    assert.equal(fixture.state.calls.length, foreignCalls, 'credential-bound client scope cannot trigger foreign upstream work');
    const next = ok(await fixture.chat({ history_mode: 'delta', messages: [{ role: 'user', content: 'CTX_CLIENT_SCOPE_OWNER_NEXT' }] }, {
      key: SHARED_KEY, headers: { ...headers, 'x-conversation-id': initial.id },
    }));
    assert.equal(next.json.conversation_id, initial.id, 'the original credential and client scope continue normally');
  });

  test('sequential explicit delta advances parents after every completed turn', async () => {
    const initial = await seed('CTX_SEQUENTIAL_SEED');
    let expectedParent = initial.generation.assistantMessageId;
    const expectedMarkers = ['CTX_SEQUENTIAL_SEED'];
    for (let index = 0; index < 3; index++) {
      const marker = `CTX_SEQUENTIAL_TURN_${index}`;
      const start = fixture.state.generations.length;
      const result = ok(await fixture.chat({
        history_mode: 'delta', conversation_id: initial.id,
        messages: [{ role: 'user', content: marker }],
      }));
      const generation = fixture.state.generations[start];
      assert.equal(result.json.conversation_id, initial.id);
      assert.equal(generation.data.id, expectedParent, 'next delta uses the last committed assistant, not the root');
      expectedMarkers.push(marker);
      ownMarkers(chatText(result), expectedMarkers, `sequential delta ${index}`);
      expectedParent = generation.assistantMessageId;
    }
  });

  test('concurrent explicit deltas serialize generation and leaf commit for one conversation', async () => {
    const initial = await seed('CTX_SERIAL_SEED');
    const start = fixture.state.generations.length;
    fixture.state.resetConcurrency();
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => fixture.chat({
      history_mode: 'delta', conversation_id: initial.id,
      messages: [{ role: 'user', content: `CTX_SERIAL_TURN_${index}` }],
    })));
    for (const result of results) {
      ok(result, 'concurrent delta');
      assert.equal(result.json.conversation_id, initial.id);
    }
    const turns = fixture.state.generations.slice(start);
    assert.equal(turns.length, 8, 'one generation per delta, without retries or fresh conversations');
    assert.equal(fixture.state.maxActiveGenerations, 1, 'one upstream generation at a time for one conversation');
    assert.equal(fixture.state.maxActiveByConversation.get(initial.id), 1, 'generation and delayed finalization never overlap the next turn');
    let expectedParent = initial.generation.assistantMessageId;
    const seen = ['CTX_SERIAL_SEED'];
    for (const turn of turns) {
      assert.equal(turn.conversationId, initial.id);
      assert.equal(turn.data.id, expectedParent, 'queued delta looks up the leaf after its predecessor commits');
      const submitted = markers(turn.source);
      assert.equal(submitted.length, 1, 'delta submits one new marker');
      seen.push(...submitted);
      const reply = results.find((result) => chatText(result).includes(submitted[0]));
      assert.ok(reply, 'a client receives this turn');
      // Match the unique last marker by the independently recorded reply text.
      assert.ok(results.some((result) => chatText(result) === turn.reply), 'each committed upstream reply reaches a caller');
      ownMarkers(turn.reply, seen, 'serialized turn retains all preceding committed turns');
      expectedParent = turn.assistantMessageId;
    }
  });

  test('different owned conversations keep upstream concurrency while each conversation serializes', async () => {
    const initial = await Promise.all(Array.from({ length: 4 }, (_, index) => seed(`CTX_PARALLEL_${index}_SEED`)));
    fixture.state.resetConcurrency();
    const start = fixture.state.generations.length;
    const jobs = initial.flatMap((conversation, index) => Array.from({ length: 3 }, (_, turn) => ({
      conversation,
      marker: `CTX_PARALLEL_${index}_TURN_${turn}`,
    })));
    const results = await Promise.all(jobs.map(({ conversation, marker }) => fixture.chat({
      history_mode: 'delta', conversation_id: conversation.id,
      messages: [{ role: 'user', content: marker }],
    })));
    results.forEach((result, index) => {
      ok(result, 'independent delta');
      assert.equal(result.json.conversation_id, jobs[index].conversation.id);
    });
    assert.ok(fixture.state.maxActiveGenerations > 1, 'per-conversation locking must allow independent generations to overlap');
    for (const conversation of initial) {
      assert.equal(fixture.state.maxActiveByConversation.get(conversation.id), 1, 'each conversation keeps generation and commit exclusive');
      const turns = fixture.state.generations.slice(start).filter((turn) => turn.conversationId === conversation.id);
      assert.equal(turns.length, 3);
      let parent = conversation.generation.assistantMessageId;
      for (const turn of turns) {
        assert.equal(turn.data.id, parent, 'independent conversation has an unbroken parent chain');
        parent = turn.assistantMessageId;
      }
    }
  });

  test('an owned delta whose upstream conversation disappeared never retries as fresh', async () => {
    const initial = await seed('CTX_DELETED_UPSTREAM_SEED');
    fixture.state.conversations.delete(initial.id);
    const before = fixture.state.calls.length;
    const creates = fixture.state.calls.filter((call) => call.path === '/api/conversation').length;
    const result = await fixture.chat({
      history_mode: 'delta', conversation_id: initial.id,
      messages: [{ role: 'user', content: 'CTX_DELETED_UPSTREAM_DELTA' }],
    });
    expired(result, 'upstream conversation disappeared');
    assert.equal(fixture.state.calls.filter((call) => call.path === '/api/conversation').length, creates,
      'missing upstream delta is not silently restarted without history');
    assert.ok(fixture.state.calls.length > before, 'a registered ID may be checked with its owning upstream');
  });

  for (const route of ['messages', 'stop']) {
    for (const kind of ['foreign', 'unknown']) {
      test(`${kind} conversation ${route} returns 404 without upstream calls`, async () => {
        const initial = kind === 'foreign' ? await seed(`CTX_ROUTE_${route.toUpperCase()}_PRIVATE`, MANAGED_A) : null;
        const before = fixture.state.calls.length;
        const result = await fixture.request(`/v1/conversations/${initial?.id || 'never-owned-route-id'}/${route}`, {
          key: MANAGED_B,
          method: route === 'stop' ? 'POST' : 'GET',
        });
        assert.equal(result.status, 404, `${kind} ${route}: ${result.text}`);
        assert.equal(fixture.state.calls.length, before, `${kind} ${route} is denied before upstream`);
      });
    }
  }

  test('the owning scope can read and stop its conversation', async () => {
    const initial = await seed('CTX_ROUTE_OWNER', MANAGED_A);
    const messages = ok(await fixture.request(`/v1/conversations/${initial.id}/messages`, { key: MANAGED_A }));
    assert.equal(messages.json.conversationId, initial.id);
    assert.ok(messages.json.messages.some((message) => message.id === initial.generation.assistantMessageId));
    const stopped = ok(await fixture.request(`/v1/conversations/${initial.id}/stop`, { key: MANAGED_A, method: 'POST' }));
    assert.equal(stopped.json.ok, true);
  });

  const adapters = [
    {
      name: 'Responses', route: '/v1/responses',
      body: (messages) => ({ model: 'sakana-namazu', input: messages, stream: false }),
      text: (result) => result.json.output?.flatMap((item) => item.content || []).map((part) => part.text || '').join(''),
    },
    {
      name: 'Anthropic', route: '/v1/messages',
      body: (messages) => ({ model: 'sakana-namazu', messages, max_tokens: 100, stream: false }),
      text: (result) => result.json.content?.map((part) => part.text || '').join('') || '',
    },
    {
      name: 'Gemini', model: 'sakana', route: '/v1beta/models/sakana:generateContent',
      body: (messages) => ({ contents: messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : message.role,
        parts: [{ text: message.content }],
      })) }),
      text: (result) => result.json.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '',
    },
  ];

  for (const adapter of adapters) {
    for (const historyMode of [undefined, 'full']) {
      test(`${adapter.name} preserves ${historyMode || 'default'} full history and creates a fresh conversation despite an explicit ID`, async () => {
        const prefix = `CTX_ADAPTER_${adapter.name.toUpperCase()}_${historyMode ? 'FULL' : 'DEFAULT'}`;
        const initial = await seed(`${prefix}_FIRST`, MANAGED_A);
        const start = fixture.state.generations.length;
        const result = ok(await fixture.request(adapter.route, { key: MANAGED_A, method: 'POST', body: {
          ...adapter.body([
            { role: 'user', content: `${prefix}_FIRST` },
            { role: 'assistant', content: chatText(initial.result) },
            { role: 'user', content: `${prefix}_SECOND` },
          ]),
          conversation_id: initial.id,
          ...(historyMode ? { history_mode: historyMode } : {}),
        } }), adapter.name);
        const turn = fixture.state.generations[start];
        assert.ok(turn, 'adapter submitted a generation');
        assert.notEqual(turn.conversationId, initial.id, 'full-history adapter creates a new upstream conversation');
        ownMarkers(turn.source, [`${prefix}_FIRST`, `${prefix}_SECOND`], 'adapter full upstream source');
        ownMarkers(adapter.text(result), [`${prefix}_FIRST`, `${prefix}_SECOND`], 'adapter full reply');
      });
    }

    test(`${adapter.name} forwards explicit delta mode and header-only conversation ID`, async () => {
      const prefix = `CTX_ADAPTER_${adapter.name.toUpperCase()}_DELTA`;
      const initial = await seed(`${prefix}_FIRST`, MANAGED_A, adapter.model || 'sakana-namazu');
      const start = fixture.state.generations.length;
      const result = ok(await fixture.request(adapter.route, { key: MANAGED_A, method: 'POST',
        headers: { 'x-conversation-id': initial.id },
        body: { ...adapter.body([{ role: 'user', content: `${prefix}_SECOND` }]), history_mode: 'delta' },
      }), `${adapter.name} delta`);
      const turn = fixture.state.generations[start];
      assert.equal(turn.conversationId, initial.id, 'history_mode survives request adaptation');
      assert.equal(turn.data.id, initial.generation.assistantMessageId, 'adapter delta uses the completed leaf');
      ownMarkers(turn.source, [`${prefix}_SECOND`], 'adapter delta upstream source');
      ownMarkers(adapter.text(result), [`${prefix}_FIRST`, `${prefix}_SECOND`], 'adapter delta reply');
    });

    test(`${adapter.name} rejects delta without an ID before any upstream call`, async () => {
      const before = fixture.state.calls.length;
      const result = await fixture.request(adapter.route, { key: MANAGED_A, method: 'POST', body: {
        ...adapter.body([{ role: 'user', content: 'CTX_ADAPTER_MISSING_DELTA_ID' }]), history_mode: 'delta',
      } });
      assert.ok(result.status === 400 || result.status === 409, `${adapter.name} missing delta ID must be rejected: ${result.text}`);
      assert.ok(result.json.error, 'adapter returns an error for missing delta ID');
      assert.equal(fixture.state.calls.length, before, 'adapter cannot drop delta mode and create fresh history');
    });
  }
});

test('conversation lists include only entries registered to the requesting credential', async () => {
  const fixture = await startContextIsolationFixture();
  try {
    const owned = [];
    for (const [index, owner] of credentials.entries()) {
      const reply = ok(await fixture.chat({ messages: [{ role: 'user', content: `CTX_LIST_OWNER_${index}` }] }, { key: owner.key }));
      owned.push({ ...owner, id: reply.json.conversation_id });
    }
    const results = [];
    for (const owner of owned) results.push({ owner, result: await fixture.request('/v1/conversations', { key: owner.key }) });
    for (const { owner, result } of results) {
      if (owner.key === ADMIN_KEY) {
        const listed = listIds(result);
        assert.ok(listed.includes(owner.id), 'admin list includes its registered conversation');
        assert.ok(listed.includes('upstream-unregistered'), 'admin may inspect upstream conversations from the shared account');
        for (const business of owned.filter((candidate) => candidate.key !== ADMIN_KEY)) {
          assert.ok(listed.includes(business.id), 'admin sees upstream account history');
        }
        continue;
      }
      assert.deepEqual(listIds(result), [owner.id], `${owner.name} sees only its own business entry, even when upstream shares one account`);
      for (const foreign of owned.filter((candidate) => candidate.id !== owner.id)) {
        assert.equal(result.text.includes(foreign.id), false, 'foreign IDs are absent from business list responses');
      }
      assert.equal(result.text.includes('upstream-unregistered'), false, 'unregistered account history is absent from business lists');
    }
    assert.deepEqual(fixture.state.errors, []);
  } finally { await fixture.close(); }
});

for (const mode of ['zero managed keys', 'all managed keys revoked']) {
  test(`admin-only configuration stays keyed with ${mode}`, async () => {
    const fixture = await startContextIsolationFixture({ apiKey: '', keys: [] });
    try {
      let revokedToken;
      if (mode === 'all managed keys revoked') {
        const created = ok(await fixture.request('/api/keys', {
          key: ADMIN_KEY, method: 'POST', body: { name: 'revoked-business-key' },
        }));
        revokedToken = created.json.key;
        assert.ok(revokedToken, 'admin creates a managed key in temporary durable storage');
        const enabled = ok(await fixture.request('/v1/models', { key: revokedToken }));
        assert.equal(enabled.json.object, 'list', 'managed key is usable before revocation');
        const revoked = ok(await fixture.request(`/api/keys/${created.json.id}/revoke`, { key: ADMIN_KEY, method: 'POST' }));
        assert.equal(revoked.json.ok, true);
      }
      const results = [];
      const before = fixture.state.calls.length;
      for (const key of [null, 'invalid-business-token', ...(revokedToken ? [revokedToken] : [])]) {
        for (const route of ['/v1/models', '/v1/chat/completions', '/api/stats']) {
          results.push({ key, route, result: await fixture.request(route, {
            key,
            method: route === '/v1/chat/completions' ? 'POST' : 'GET',
            ...(route === '/v1/chat/completions' ? { body: {
              model: 'sakana-namazu', stream: false,
              messages: [{ role: 'user', content: 'CTX_ADMIN_ONLY_AUTH_REQUIRED' }],
            } } : {}),
          }) });
        }
      }
      const upstreamCalls = fixture.state.calls.length - before;
      const stats = ok(await fixture.request('/api/stats', { key: ADMIN_KEY }));
      const models = ok(await fixture.request('/v1/models', { key: ADMIN_KEY }));
      assert.equal(models.json.object, 'list', 'configured admin key remains usable');
      for (const { key, route, result } of results) {
        assert.equal(result.status, 401, `${mode}, ${key === null ? 'no token' : 'invalid/revoked token'} on ${route}: ${result.text}`);
      }
      assert.equal(upstreamCalls, 0, 'unauthenticated admin-only traffic never reaches upstream');
      assert.equal(stats.json.ops?.authMode, 'keyed', 'stats reports the admin-only server as keyed');
      assert.deepEqual(fixture.state.errors, []);
    } finally { await fixture.close(); }
  });
}
