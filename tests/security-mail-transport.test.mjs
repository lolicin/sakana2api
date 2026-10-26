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
const { fetchRemoteJson } = require('../lib/remote-fetch.js');
const server = createServer(async (req, res) => {
  for await (const _chunk of req) {}
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ method: req.method, path: req.url }));
});
let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  globalThis.fetch = nativeFetch;
  dns.lookup = nativeLookup;
  net.connect = nativeConnect;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('mailbox JSON transport rejects loopback before sending its API key', async (t) => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  t.after(() => { globalThis.fetch = nativeFetch; });
  await assert.rejects(fetchRemoteJson(`${base}/me`, { headers: { 'X-API-Key': 'synthetic' } }), { code: 'ATTACHMENT_INVALID_SOURCE' });
  assert.equal(calls, 0);
});

test('mailbox JSON transport pins policy before the fetch boundary', async (t) => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'http://93.184.216.34/me');
    assert.equal(new Headers(init.headers).get('x-api-key'), 'synthetic');
    return Response.json({ ok: true });
  };
  t.after(() => { globalThis.fetch = nativeFetch; });
  const result = await fetchRemoteJson('http://93.184.216.34/me', { headers: { 'X-API-Key': 'synthetic' } });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
});

test('mailbox JSON transport preserves public request method, body and parses response', async (t) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body });
    return Response.json({ method: init.method, path: new URL(url).pathname });
  };
  t.after(() => { globalThis.fetch = nativeFetch; });
  const result = await fetchRemoteJson('http://93.184.216.34/domains', { method: 'POST', body: '{"probe":true}' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { method: 'POST', path: '/domains' });
  assert.deepEqual(calls, [{ url: 'http://93.184.216.34/domains', method: 'POST', body: '{"probe":true}' }]);
});

test('mailbox JSON transport cancels oversized responses', async (t) => {
  let cancelled = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(32)); },
    cancel() { cancelled++; },
  }));
  t.after(() => { globalThis.fetch = nativeFetch; });
  await assert.rejects(fetchRemoteJson('http://93.184.216.34/me', { maxBytes: 16 }), { code: 'ATTACHMENT_TOO_LARGE' });
  assert.equal(cancelled, 1);
});

console.log('mail transport security tests: all passed');
