// Usage accounting regression: the proxy's usage must reflect the ENTIRE
// upstream context (assembled prompt + attachments + optical pages), not just
// the output — and total_tokens must be prompt+completion (it used to be 0).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 1x1 PNG (IHDR width=1 height=1) — enough for the pixel-based estimator.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const upstreamServer = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const url = new URL(req.url, 'http://fake-upstream');
  if (req.method === 'POST' && url.pathname === '/api/conversation') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ conversationId: 'c-usage-1', systemMessageId: 's-1' }));
  }
  if (/^\/api\/conversation\/.+/.test(url.pathname) && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
    return res.end(JSON.stringify({ type: 'finalAnswer', text: '好的，收到。' }) + '\n');
  }
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', r));
const upstreamPort = upstreamServer.address().port;
const serverPort = 24300 + Math.floor(Math.random() * 300);

const env = {
  ...process.env,
  AUTO_SESSION: 'false', API_KEY: '', PORT: String(serverPort), HOST: '127.0.0.1',
  SAKANA_BASE: `http://127.0.0.1:${upstreamPort}`, SAKANA_COOKIE: 'fake-cookie=fake',
  CACHE_ENABLED: 'false',
};
const child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
const out = [];
child.stdout.on('data', (c) => out.push(c.toString()));
child.stderr.on('data', (c) => out.push(c.toString()));

async function waitReady() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${serverPort}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not start');
}

async function chat(body) {
  const r = await fetch(`http://127.0.0.1:${serverPort}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r;
}

let passed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name} ${detail}`); process.exitCode = 1; }
}

try {
  await waitReady();

  // -- unit sanity on the estimator ---------------------------------------
  const { estimateTokens, pngDimensions } = await import(pathToFileURL(path.join(root, 'lib', 'token-estimate.js')).href);
  const cjk = '长文上下文'.repeat(100); // 500 CJK chars
  check('CJK estimate ≈ 1 token/char', estimateTokens(cjk) >= 450 && estimateTokens(cjk) <= 550, String(estimateTokens(cjk)));
  check('latin /4 estimate', estimateTokens('abcdefgh') === 2);
  const dims = pngDimensions(TINY_PNG);
  check('PNG IHDR dims parsed', dims && dims.width === 1 && dims.height === 1, JSON.stringify(dims));

  // -- non-stream: prompt tokens reflect CJK prompt, total != 0 ----------
  // 720 raw chars; the assembled upstream prompt adds role framing, so the
  // honest expectation is "at least the CJK content cost, plus modest framing".
  const longPrompt = '这是一段很长的中文上下文。'.repeat(60);
  let r = await chat({ model: 'sakana', stream: false, messages: [{ role: 'user', content: longPrompt }] });
  let j = await r.json();
  const basePromptTokens = j.usage?.prompt_tokens;
  check('non-stream prompt_tokens ≈ CJK count', basePromptTokens >= 690 && basePromptTokens <= 1000, `${basePromptTokens}`);
  check('non-stream total = prompt + completion', j.usage.total_tokens === j.usage.prompt_tokens + j.usage.completion_tokens, JSON.stringify(j.usage));
  check('non-stream completion CJK-aware', j.usage.completion_tokens >= 4, JSON.stringify(j.usage)); // '好的，收到。' ≈ 6

  // -- non-stream with image attachment: prompt_tokens grows -------------
  r = await chat({
    model: 'sakana', stream: false,
    messages: [{ role: 'user', content: [
      { type: 'text', text: longPrompt },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + TINY_PNG.toString('base64') } },
    ] }],
  });
  j = await r.json();
  check('image attachment adds vision tokens', j.usage.prompt_tokens >= basePromptTokens + 85, `${basePromptTokens} -> ${j.usage.prompt_tokens}`);

  // -- stream: tail usage chunk carries the same accounting --------------
  const sse = await chat({ model: 'sakana', stream: true, messages: [{ role: 'user', content: longPrompt }] });
  const text = await sse.text();
  const tailMatches = [...text.matchAll(/data: (\{.*?"choices":\[\].*?\})\n/g)];
  const tail = tailMatches.length ? JSON.parse(tailMatches[tailMatches.length - 1][1]) : null;
  check('stream tail usage chunk present', !!tail && typeof tail.usage === 'object');
  check('stream tail prompt_tokens ≈ non-stream', tail && Math.abs(tail.usage.prompt_tokens - basePromptTokens) <= 5, `${tail?.usage?.prompt_tokens} vs ${basePromptTokens}`);
  check('stream tail total = p + c', tail && tail.usage.total_tokens === tail.usage.prompt_tokens + tail.usage.completion_tokens, JSON.stringify(tail?.usage));

  console.log(passed === 10 ? 'usage accounting tests: all passed' : 'usage accounting tests: FAILED');
} catch (e) {
  console.error('FATAL', e);
  console.error(out.join('').slice(-2000));
  process.exitCode = 1;
} finally {
  child.kill('SIGKILL');
  await new Promise((r) => upstreamServer.close(r));
}
