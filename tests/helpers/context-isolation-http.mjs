import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SHARED_KEY = 'context-isolation-static-business';
export const ADMIN_KEY = 'context-isolation-static-admin';
export const MANAGED_A = 'context-isolation-managed-a';
export const MANAGED_B = 'context-isolation-managed-b';

export function managedKey(token, id) {
  return {
    id,
    name: 'same-display-name',
    hash: createHash('sha256').update(token).digest('hex'),
    prefix: token.slice(0, 12),
    created: Date.now(),
    lastUsed: null,
    revoked: false,
  };
}

export function markers(text) {
  return [...new Set(String(text).match(/CTX_[A-Z0-9_]+/g) || [])].sort();
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closed;
}

function newConversation(id, create = {}) {
  const rootId = `system-${id}`;
  return {
    id,
    rootId,
    create,
    messages: [{ id: rootId, role: 'system', content: '', ancestors: [], children: [] }],
  };
}

function fakeUpstream({ generationDelayMs = 35, commitDelayMs = 25 } = {}) {
  const state = {
    calls: [],
    generations: [],
    conversations: new Map(),
    errors: [],
    nextConversation: 1,
    active: 0,
    maxActive: 0,
    activeGenerations: 0,
    maxActiveGenerations: 0,
    activeByConversation: new Map(),
    maxActiveByConversation: new Map(),
    resetConcurrency() {
      assert.equal(this.active, 0, 'concurrency measurements start after prior HTTP work has finished');
      this.maxActive = 0;
      this.maxActiveGenerations = 0;
      this.maxActiveByConversation.clear();
    },
  };
  // Exists upstream, but has never been registered by any proxy credential.
  state.conversations.set('upstream-unregistered', newConversation('upstream-unregistered'));

  function trackRequest(id, res, generation) {
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    const active = (state.activeByConversation.get(id) || 0) + 1;
    state.activeByConversation.set(id, active);
    state.maxActiveByConversation.set(id, Math.max(state.maxActiveByConversation.get(id) || 0, active));
    if (generation) {
      state.activeGenerations++;
      state.maxActiveGenerations = Math.max(state.maxActiveGenerations, state.activeGenerations);
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      state.active--;
      state.activeByConversation.set(id, state.activeByConversation.get(id) - 1);
      if (generation) state.activeGenerations--;
    };
    res.once('finish', finish);
    res.once('close', finish);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      state.calls.push({ method: req.method, path: url.pathname });
      if (req.method === 'POST' && url.pathname === '/api/conversation') {
        const create = JSON.parse((await readRequest(req)).toString('utf8') || '{}');
        const id = `upstream-context-${state.nextConversation++}`;
        const conversation = newConversation(id, create);
        state.conversations.set(id, conversation);
        return sendJson(res, 200, { conversationId: id, systemMessageId: conversation.rootId });
      }
      if (req.method === 'GET' && url.pathname === '/api/v2/conversations') {
        return sendJson(res, 200, { json: { conversations: [...state.conversations.values()].map((conv) => ({
          id: conv.id,
          conversationId: conv.id,
          title: `conversation ${conv.id}`,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        })), nextPage: null } });
      }
      const match = /^\/api\/conversation\/([^/]+)(?:\/(stop|compact))?$/.exec(url.pathname);
      if (!match) throw new Error(`unexpected upstream route: ${req.method} ${url.pathname}`);
      const id = decodeURIComponent(match[1]);
      const conversation = state.conversations.get(id);
      const generation = req.method === 'POST' && !match[2];
      trackRequest(id, res, generation);
      if (!conversation) {
        await readRequest(req);
        return sendJson(res, 404, { errorCode: 'CONV-NOTFOUND-001' });
      }
      if (req.method === 'GET' && !match[2]) {
        // A turn is only committed after the proxy has read the new leaf.
        // This delay also catches locks that cover generation but skip commit.
        await delay(commitDelayMs);
        return sendJson(res, 200, { conversationId: id, messages: conversation.messages });
      }
      if (req.method === 'POST' && match[2]) {
        await readRequest(req);
        return sendJson(res, 200, { ok: true });
      }
      if (!generation) throw new Error(`unexpected upstream method: ${req.method} ${url.pathname}`);

      const raw = await readRequest(req);
      const form = await new Response(raw, {
        headers: { 'content-type': req.headers['content-type'] },
      }).formData();
      assert.equal(typeof form.get('data'), 'string', 'generation includes multipart JSON data');
      const data = JSON.parse(form.get('data'));
      const files = [];
      for (const file of form.getAll('files')) {
        assert.equal(typeof file.arrayBuffer, 'function', 'multipart files preserve their binary bodies');
        const bytes = Buffer.from(await file.arrayBuffer());
        files.push({
          name: file.name,
          type: file.type,
          decoded: file.name.startsWith('base64;') ? Buffer.from(bytes.toString('utf8'), 'base64') : bytes,
        });
      }
      const source = [data.inputs || '', ...files.map((file) => file.decoded.toString('utf8'))].join('\n');
      const parent = conversation.messages.find((message) => message.id === data.id);
      if (!parent) return sendJson(res, 400, { errorCode: 'CONV-MSG-001' });
      const assistantMessageId = `assistant-${id}-${state.generations.length + 1}`;
      const recorded = { conversationId: id, data, files, source, assistantMessageId };
      state.generations.push(recorded);
      await delay(generationDelayMs);

      // Follow the submitted parent, rather than unioning every branch. A stale
      // parent therefore really loses history, and a foreign parent leaks it.
      const inherited = [...parent.ancestors, parent.id]
        .map((ancestorId) => conversation.messages.find((message) => message.id === ancestorId)?.content || '')
        .join('\n');
      const reply = `Seen markers: ${markers(`${inherited}\n${source}`).join(' ') || '(none)'}`;
      const user = {
        id: data.userMessageId,
        role: 'user',
        content: source,
        ancestors: [...parent.ancestors, parent.id],
        children: [assistantMessageId],
      };
      const assistant = {
        id: assistantMessageId,
        role: 'assistant',
        content: reply,
        ancestors: [...user.ancestors, user.id],
        children: [],
        active: true,
      };
      for (const message of conversation.messages) message.active = false;
      parent.children.push(user.id);
      conversation.messages.push(user, assistant);
      recorded.reply = reply;
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      res.end(`${JSON.stringify({ type: 'stream', token: reply })}\n`);
    } catch (error) {
      state.errors.push(error);
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
      else res.end();
    }
  });
  return { server, state };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

export async function startContextIsolationFixture({
  apiKey = SHARED_KEY,
  keys = [managedKey(MANAGED_A, 'managed-a-id'), managedKey(MANAGED_B, 'managed-b-id')],
} = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sakana-context-http-'));
  const { server: upstreamServer, state } = fakeUpstream();
  let child;
  const output = [];
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try { await stopChild(child); }
    finally {
      try { await closeServer(upstreamServer); }
      finally { await rm(temporary, { recursive: true, force: true }); }
    }
  }

  try {
    const upstreamPort = await listen(upstreamServer);
    const reservation = createServer();
    const port = await listen(reservation);
    await closeServer(reservation);
    const base = `http://127.0.0.1:${port}`;
    const session = {
      id: 'context-isolation-account',
      uid: 'context-isolation-user',
      email: 'context-isolation@example.test',
      savedAt: Date.now(),
      cookieHeader: 'sakana-chat=local-test-only',
      cookies: [{ name: 'sakana-chat', value: 'local-test-only', domain: '127.0.0.1', path: '/' }],
    };
    const file = (name) => path.join(temporary, name);
    await Promise.all([
      writeFile(file('session.json'), JSON.stringify(session)),
      writeFile(file('account-pool.json'), '[]'),
      writeFile(file('keys.json'), JSON.stringify(keys)),
      writeFile(file('admin-key'), ADMIN_KEY),
      writeFile(file('audit.json'), '[]'),
      writeFile(file('mail-config.json'), '{}'),
    ]);
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: temporary,
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=512',
        AUTO_SESSION: 'false',
        HOST: '127.0.0.1',
        PORT: String(port),
        API_KEY: apiKey,
        ADMIN_API_KEY: ADMIN_KEY,
        SAKANA_BASE: `http://127.0.0.1:${upstreamPort}`,
        SAKANA_COOKIE: session.cookieHeader,
        SAKANA_SESSION_FILE: file('session.json'),
        SAKANA_ACCOUNT_POOL_FILE: file('account-pool.json'),
        SAKANA_KEYS_FILE: file('keys.json'),
        SAKANA_ADMIN_KEY_FILE: file('admin-key'),
        SAKANA_AUDIT_FILE: file('audit.json'),
        SAKANA_MAIL_CONFIG_FILE: file('mail-config.json'),
        YYDS_SCORES_FILE: file('mail-scores.json'),
        SAKANA_NATIVE: '0',
        CACHE_ENABLED: 'false',
        OPTICAL_CONTEXT: '0',
        CONTEXT_COMPACT_THRESHOLD_BYTES: '0',
        WRITER_COMPACT_THRESHOLD_BYTES: '0',
        MAX_CONCURRENT_PER_ACCOUNT: '100',
        QUEUE_MAX_SIZE: '1000',
        QUEUE_TIMEOUT_MS: '10000',
        REQUEST_TIMEOUT_MS: '20000',
        UPSTREAM_TIMEOUT_MS: '10000',
        UPSTREAM_BOOTSTRAP_MS: '10000',
        SHUTDOWN_DRAIN_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk) => output.push(chunk.toString()));
    child.on('error', (error) => output.push(String(error)));

    let ready = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try {
        const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
        await response.arrayBuffer();
        if (response.ok) { ready = true; break; }
      } catch {}
      await delay(30);
    }
    if (!ready) throw new Error(`HTTP fixture server did not start\n${output.join('')}`);

    async function request(pathname, { key = SHARED_KEY, method = 'GET', body, headers = {} } = {}) {
      const response = await fetch(base + pathname, {
        method,
        headers: {
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); }
      catch { throw new Error(`${method} ${pathname} returned non-JSON (${response.status}): ${text.slice(0, 500)}`); }
      return { status: response.status, headers: response.headers, json, text };
    }

    return {
      base,
      upstreamBase: `http://127.0.0.1:${upstreamPort}`,
      state,
      request,
      close,
      output,
      chat(body, options = {}) {
        return request('/v1/chat/completions', {
          ...options,
          method: 'POST',
          body: { model: 'sakana-namazu', stream: false, web_search: false, thinking: false, ...body },
        });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
