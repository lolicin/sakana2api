import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test, { after, before } from 'node:test';

const require = createRequire(import.meta.url);
const nativeFetch = globalThis.fetch;
const nativeLookup = dns.lookup;
const nativeConnect = net.connect;
let upstream;
let closeGlobalDispatcher;
let selectActiveLeaf;
let base;
const received = [];
const server = createServer(async (req, res) => {
  for await (const _chunk of req) {}
  received.push({ path: req.url, cookie: req.headers.cookie });
  res.setHeader('content-type', 'application/json');
  res.end(req.url === '/api/conversation' ? '{"conversationId":"conv-test","systemMessageId":"s"}' : '{}');
});
const { normalizeAttachment, normalizeRequestBody } = require('../lib/request-normalizer.js');
const { fetchRemoteJson } = require('../lib/remote-fetch.js');

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.SAKANA_BASE = base;
  const module = require('../lib/upstream.js');
  ({ closeGlobalDispatcher, selectActiveLeaf } = module);
  upstream = new module.SakanaUpstream(() => ({ cookieHeader: 'synthetic=session' }));
});
after(async () => {
  globalThis.fetch = nativeFetch;
  dns.lookup = nativeLookup;
  net.connect = nativeConnect;
  await closeGlobalDispatcher();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function response(text = 'synthetic') {
  return new Response(text, { headers: { 'content-type': 'image/png' } });
}
async function pending(url, extra = {}) {
  const result = await upstream.streamGenerate('conv-test', { prompt: 'synthetic', files: [{ name: 'test.png', pendingUrl: url, ...extra }] });
  await result.body?.cancel();
}
function forbidden(error) {
  assert.equal(error.code || error.errorCode, 'ATTACHMENT_INVALID_SOURCE');
  return true;
}
function installFetch(t, handler) {
  globalThis.fetch = handler;
  t.after(() => { globalThis.fetch = nativeFetch; });
}

for (const [label, invoke] of [
  ['normalizer', (url) => normalizeAttachment({ url }, 0)],
  ['upstream', (url) => pending(url, { allowPrivate: true, skipRemoteValidation: true })],
]) {
  test(`remote security: ${label} rejects non-public literal addresses before fetch`, async (t) => {
    let calls = 0;
    installFetch(t, async () => { calls++; return response(); });
    for (const host of [
      '127.0.0.1', '127.1', '2130706433', '0x7f000001', '0.0.0.1', '10.2.3.4', '172.16.2.3', '192.168.1.2',
      '169.254.169.254', '100.64.0.1', '192.0.0.1', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.51.100.1',
      '203.0.113.1', '192.31.196.1', '192.52.193.1', '192.175.48.1', '224.0.0.1', '240.0.0.1', '[::]', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]',
      '[::ffff:192.168.1.1]', '[fe90::1]', '[fd00::1]', '[ff02::1]', '[2001:db8::1]', '[2002:7f00:1::]',
      '[64:ff9b::7f00:1]', '[2620:4f:8000::1]', 'localhost.', 'synthetic.internal',
    ]) {
      await assert.rejects(invoke(`http://${host}/image`), forbidden, host);
    }
    assert.equal(calls, 0);
  });

  test(`remote security: ${label} validates redirect destinations and cancels the old body`, async (t) => {
    let cancelled = 0;
    const calls = [];
    installFetch(t, async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
        status: 302, headers: { location: 'http://[::ffff:127.0.0.1]/synthetic' },
      });
    });
    await assert.rejects(invoke('http://93.184.216.34/image'), forbidden);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(cancelled, 1);
  });

  test(`remote security: ${label} supports safe relative redirects with bounded reads`, async (t) => {
    const calls = [];
    installFetch(t, async (url, init) => {
      if (String(url).startsWith(base)) return response('{}');
      calls.push({ url: String(url), init });
      if (calls.length === 1) return new Response(null, { status: 307, headers: { location: '/next' } });
      return response();
    });
    await invoke('http://93.184.216.34/image');
    assert.deepEqual(calls.map((call) => call.url), ['http://93.184.216.34/image', 'http://93.184.216.34/next']);
    for (const { init } of calls) {
      assert.equal(init.redirect, 'manual');
      assert.equal(init.credentials, 'omit');
      assert.ok(init.dispatcher && typeof init.dispatcher.dispatch === 'function');
      assert.equal(new Headers(init.headers).has('cookie'), false);
      assert.equal(new Headers(init.headers).has('authorization'), false);
    }
    assert.equal(calls[0].init.signal, calls[1].init.signal, 'redirects share one deadline and abort signal');
  });
}

test('remote security: client body cannot opt out of the normalizer policy', async (t) => {
  let calls = 0;
  installFetch(t, async () => { calls++; return response(); });
  await assert.rejects(normalizeRequestBody({
    allowPrivate: true, skipRemoteValidation: true,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `${base}/synthetic`, allowPrivate: true } }] }],
  }), forbidden);
  assert.equal(calls, 0);
});

test('remote security: configured local SAKANA_BASE remains usable for authenticated calls', async () => {
  const result = await upstream.createConversation();
  assert.equal(result.conversationId, 'conv-test');
  assert.equal(received.at(-1).cookie, 'synthetic=session');
});

// Exercise the actual Undici connector with synthetic DNS and a socket that
// never dials. This detects missing guards even when fetch itself is mocked.
async function inspectLookup(t, answers, invokeTwice = false) {
  let lookups = 0;
  const seen = [];
  dns.lookup = (_hostname, options, callback) => {
    lookups++;
    const result = lookups === 1 ? answers : [{ address: '127.0.0.1', family: 4 }];
    queueMicrotask(() => callback(null, options?.all ? result : result[0].address, result[0].family));
  };
  net.connect = (options) => {
    const socket = new net.Socket();
    queueMicrotask(async () => {
      try {
        assert.equal(typeof options.lookup, 'function', 'per-request connector supplies pinned lookup');
        for (let index = 0; index < (invokeTwice ? 2 : 1); index++) {
          const result = await new Promise((resolve) => options.lookup(options.host, { all: true }, (error, addresses) => resolve({ error, addresses })));
          seen.push(result);
        }
      } catch (error) {
        seen.push({ error });
      } finally {
        socket.destroy(Object.assign(new Error('synthetic transport stop'), { code: 'ECONNREFUSED' }));
      }
    });
    return socket;
  };
  t.after(() => { dns.lookup = nativeLookup; net.connect = nativeConnect; });
  await assert.rejects(normalizeAttachment({ url: 'http://synthetic-dns.test/image' }, 0));
  return { seen, lookups };
}

for (const answers of [
  [{ address: '127.0.0.1', family: 4 }],
  [{ address: '::ffff:10.0.0.1', family: 6 }],
  [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }],
]) {
  test(`remote security: connection lookup rejects DNS answer ${answers.map((answer) => answer.address).join(',')}`, async (t) => {
    const { seen } = await inspectLookup(t, answers);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].error?.code, 'ATTACHMENT_INVALID_SOURCE');
    assert.equal(seen[0].addresses, undefined);
  });
}

test('remote security: connector pins public DNS answers across repeated lookups', async (t) => {
  const answers = [{ address: '93.184.216.34', family: 4 }];
  const { seen, lookups } = await inspectLookup(t, answers, true);
  assert.equal(seen.length, 2);
  assert.equal(lookups, 1, 'the connection must not resolve again after validation');
  for (const item of seen) {
    assert.equal(item.error, null);
    assert.deepEqual(item.addresses, answers);
  }
});

test('remote JSON security: credentials are stripped after origin-changing redirects', async (t) => {
  const calls = [];
  installFetch(t, async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), method: init.method, body: init.body });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'http://93.184.216.35/me' } });
    return Response.json({ ok: true });
  });
  const result = await fetchRemoteJson('http://93.184.216.34/me', {
    headers: { 'X-API-Key': 'synthetic-secret', 'content-type': 'application/json' },
    method: 'POST', body: '{"test":true}',
  });
  assert.equal(result.ok, true);
  assert.equal(result.body.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.get('x-api-key'), 'synthetic-secret');
  assert.equal(calls[1].headers.has('x-api-key'), false);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].body, undefined, 'a cross-origin redirect cannot replay credentials in a request body');
});

test('remote JSON security: response bytes are bounded before JSON parsing', async (t) => {
  let cancelled = 0;
  installFetch(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(32)); },
    cancel() { cancelled++; },
  })));
  await assert.rejects(fetchRemoteJson('http://93.184.216.34/me', { maxBytes: 16 }), { code: 'ATTACHMENT_TOO_LARGE' });
  assert.equal(cancelled, 1);
});
test('remote security: abort on an already-aborted request prevents all fetching', async (t) => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(Object.assign(new Error('synthetic abort'), { code: 'REQUEST-ABORTED' }));
  installFetch(t, async () => { calls++; return response(); });
  await assert.rejects(normalizeAttachment({ url: 'http://93.184.216.34/image' }, 0, { signal: controller.signal }), { code: 'REQUEST-ABORTED' });
  assert.equal(calls, 0);
});


test('remote security: redirects have a finite hop budget and cancel every response', async (t) => {
  let calls = 0;
  let cancelled = 0;
  installFetch(t, async () => {
    calls++;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 302, headers: { location: '/again' } });
  });
  await assert.rejects(normalizeAttachment({ url: 'http://93.184.216.34/image' }, 0), { code: 'ATTACHMENT_FETCH_FAILED' });
  assert.equal(calls, 6);
  assert.equal(cancelled, calls);
});

test('remote security: timeout covers a body read after redirects', async (t) => {
  let cancelled = 0;
  let calls = 0;
  installFetch(t, async () => {
    calls++;
    return calls === 1
      ? new Response(null, { status: 302, headers: { location: '/next' } })
      : new Response(new ReadableStream({ cancel() { cancelled++; } }));
  });
  await assert.rejects(normalizeAttachment({ url: 'http://93.184.216.34/image' }, 0, { remoteTimeoutMs: 20 }), { code: 'REQUEST-TIMEOUT' });
  assert.equal(calls, 2);
  assert.equal(cancelled, 1);
});

test('remote security: streamed bytes are bounded and oversized bodies cancelled', async (t) => {
  let cancelled = 0;
  installFetch(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(6)); },
    cancel() { cancelled++; },
  })));
  await assert.rejects(normalizeAttachment({ url: 'http://93.184.216.34/image' }, 0, { maxAttachmentBytes: 5 }), { code: 'ATTACHMENT_TOO_LARGE' });
  assert.equal(cancelled, 1);
});

test('upstream security: authenticated responses cannot redirect cookies to another origin', async (t) => {
  let calls = 0;
  let cancelled = 0;
  installFetch(t, async (_url, init) => {
    calls++;
    assert.ok(['manual', 'error'].includes(init.redirect));
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 302, headers: { location: 'http://93.184.216.34/collect' } });
  });
  await assert.rejects(upstream.createConversation(), (error) => ['UPSTREAM-ORIGIN', 'UPSTREAM-NETWORK'].includes(error.errorCode));
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});

test('cursor security: selects terminal nodes from real trees, active branches and string children', () => {
  assert.equal(selectActiveLeaf([
    { id: 's', children: ['u'] }, { id: 'u', children: ['a'] }, { id: 'a', children: [] },
  ]), 'a');
  assert.equal(selectActiveLeaf([
    { id: 's', children: ['branch-old', 'branch-new'] },
    { id: 'branch-old', isActive: true, children: 'saved-leaf' },
    { id: 'saved-leaf', children: [] },
    { id: 'branch-new', children: ['latest-leaf'] },
    { id: 'latest-leaf', children: [] },
  ]), 'saved-leaf');
  assert.equal(selectActiveLeaf([
    { id: 's', children: ['old', 'new'] }, { id: 'old', active: true }, { id: 'new' },
  ]), 'old');
  assert.equal(selectActiveLeaf([
    { id: 's', children: ['old', 'new'] }, { id: 'old' }, { id: 'new' },
  ]), 'new');
  assert.equal(selectActiveLeaf([]), '');
});
