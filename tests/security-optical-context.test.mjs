import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate as turn } from 'node:timers/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const modulePath = require.resolve('../lib/optical-context.js');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function withRenderer(run, { bytes = 1, cacheBytes = 8, entries = 2, missingPage = false, gate = null, launchGate = null } = {}) {
  const originalLaunch = chromium.launch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const env = { ...process.env };
  const timers = new Set();
  const state = { contexts: 0, active: 0, maxActive: 0, screenshots: 0, closes: 0 };
  process.env.OPTICAL_RENDER_CACHE_BYTES = String(cacheBytes);
  process.env.OPTICAL_RENDER_CACHE_ENTRIES = String(entries);
  process.env.OPTICAL_RENDER_TIMEOUT_MS = '2000';
  globalThis.setTimeout = (fn, ms, ...args) => {
    let timer;
    timer = originalSetTimeout(() => { timers.delete(timer); fn(...args); }, ms);
    timers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => { timers.delete(timer); originalClearTimeout(timer); };
  const liveContexts = new Set();
  chromium.launch = async () => {
    if (launchGate) await launchGate.promise;
    return {
    async newContext() {
      state.contexts++;
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      let closed = false;
      const closing = deferred();
      const context = {
        async newPage() {
          return {
            async setContent() {},
            async $(selector) {
              if (missingPage && selector === '#page-0') return null;
              return {
                async screenshot() {
                  state.screenshots++;
                  if (gate) await Promise.race([gate.promise, closing.promise]);
                  if (closed) throw new Error('context closed');
                  return Buffer.alloc(bytes, 1);
                },
              };
            },
          };
        },
        async close() {
          if (!closed) { closed = true; state.active--; liveContexts.delete(context); closing.resolve(); }
        },
      };
      liveContexts.add(context);
      return context;
    },
    async close() {
      state.closes++;
      await Promise.all([...liveContexts].map((context) => context.close()));
    },
  };
  };
  delete require.cache[modulePath];
  const optical = require(modulePath);
  try {
    await run(optical, state, timers);
  } finally {
    gate?.resolve();
    launchGate?.resolve();
    await optical.closeRenderer();
    await turn();
    for (const timer of timers) originalClearTimeout(timer);
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    chromium.launch = originalLaunch;
    for (const key of ['OPTICAL_RENDER_CACHE_BYTES', 'OPTICAL_RENDER_CACHE_ENTRIES', 'OPTICAL_RENDER_TIMEOUT_MS']) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
    delete require.cache[modulePath];
  }
}

test('optical security: cache hits are lazy and do not start a second render', async () => {
  await withRenderer(async (optical, state) => {
    const first = await optical.renderTextToPages('synthetic text');
    const second = await optical.renderTextToPages('synthetic text');
    await turn();
    assert.equal(first, second);
    assert.equal(state.contexts, 1);
    assert.equal(state.screenshots, 1);
  });
});

test('optical security: distinct cache misses execute serially', async () => {
  const gate = deferred();
  await withRenderer(async (optical, state) => {
    const first = optical.renderTextToPages('first');
    const second = optical.renderTextToPages('second');
    await turn();
    const activeBeforeRelease = state.active;
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(activeBeforeRelease, 1);
    assert.equal(state.maxActive, 1);
  }, { gate });
});

test('optical security: simultaneous identical misses share the rendered result and byte accounting', async () => {
  const gate = deferred();
  await withRenderer(async (optical, state) => {
    const first = optical.renderTextToPages('same');
    const second = optical.renderTextToPages('same');
    await turn();
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(state.contexts, 1);
    assert.equal(a, b);
    assert.deepEqual(optical.__renderCacheStats(), { entries: 1, bytes: 1 });
  }, { gate });
});

test('optical security: already aborted cache hits reject without rendering', async () => {
  await withRenderer(async (optical, state) => {
    await optical.renderTextToPages('cached');
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('synthetic abort'), { code: 'SERVER-SHUTDOWN' }));
    await assert.rejects(optical.renderTextToPages('cached', { signal: controller.signal }), { code: 'SERVER-SHUTDOWN' });
    assert.equal(state.contexts, 1);
  });
});

test('optical security: close clears timers and cache bytes', async () => {
  await withRenderer(async (optical, state, timers) => {
    await optical.renderTextToPages('cached');
    await optical.closeRenderer();
    assert.deepEqual(optical.__renderCacheStats(), { entries: 0, bytes: 0 });
    assert.equal(timers.size, 0);
    assert.equal(state.active, 0);
  });
});

test('optical security: close rejects active and queued work without repopulating the cache', async () => {
  const gate = deferred();
  await withRenderer(async (optical, state, timers) => {
    const first = optical.renderTextToPages('first').then(() => 'fulfilled', (error) => error.code);
    const second = optical.renderTextToPages('second').then(() => 'fulfilled', (error) => error.code);
    await turn();
    await optical.closeRenderer();
    gate.resolve();
    const outcomes = await Promise.all([first, second]);
    assert.deepEqual(outcomes, ['SERVER-SHUTDOWN', 'SERVER-SHUTDOWN']);
    assert.deepEqual(optical.__renderCacheStats(), { entries: 0, bytes: 0 });
    assert.equal(state.contexts, 1);
    assert.equal(timers.size, 0);
  }, { gate });
});

test('optical security: oversize results are not retained, even as the only entry', async () => {
  await withRenderer(async (optical, state) => {
    await optical.renderTextToPages('large');
    assert.deepEqual(optical.__renderCacheStats(), { entries: 0, bytes: 0 });
    await optical.renderTextToPages('large');
    assert.equal(state.contexts, 2);
  }, { bytes: 9 });
});

test('optical security: tiny results obey entry bounds with exact byte accounting', async () => {
  await withRenderer(async (optical) => {
    for (let index = 0; index < 5; index++) await optical.renderTextToPages(`tiny-${index}`);
    assert.deepEqual(optical.__renderCacheStats(), { entries: 2, bytes: 2 });
  });
});

test('optical security: missing screenshot elements report truncation', async () => {
  await withRenderer(async (optical) => {
    const rendered = await optical.renderTextToPages('synthetic text');
    assert.equal(rendered.pages.length, 0);
    assert.equal(rendered.truncated, true);
  }, { missingPage: true });
});

test('optical security: queued aborts are removed without launching another render', async () => {
  const gate = deferred();
  await withRenderer(async (optical, state) => {
    const first = optical.renderTextToPages('first');
    const controller = new AbortController();
    const queued = optical.renderTextToPages('queued', { signal: controller.signal });
    const rejected = assert.rejects(queued, { code: 'REQUEST-ABORTED' });
    await turn();
    controller.abort();
    await rejected;
    gate.resolve();
    await first;
    await turn();
    assert.equal(state.contexts, 1);
  }, { gate });
});

test('optical security: render timeout closes context and permits the next queued render', async () => {
  const gate = deferred();
  await withRenderer(async (optical, state) => {
    // Keep the test process alive; production renderer timers are unref'd.
    const keeper = setInterval(() => {}, 1000);
    try {
      await assert.rejects(optical.renderTextToPages('timeout'), { code: 'OPTICAL_RENDER_TIMEOUT' });
      assert.equal(state.active, 0);
      gate.resolve();
      await optical.renderTextToPages('after timeout');
      assert.equal(state.maxActive, 1);
      await optical.closeRenderer();
    } finally {
      clearInterval(keeper);
    }
  }, { gate });
});

test('optical security: a browser launched after close is closed without creating a context', async () => {
  const launchGate = deferred();
  await withRenderer(async (optical, state, timers) => {
    const rendering = optical.renderTextToPages('during launch').then(() => 'fulfilled', (error) => error.code);
    await turn();
    const closing = optical.closeRenderer();
    launchGate.resolve();
    await closing;
    assert.equal(await rendering, 'SERVER-SHUTDOWN');
    assert.equal(state.contexts, 0);
    assert.ok(state.closes >= 1);
    assert.equal(timers.size, 0);
    assert.deepEqual(optical.__renderCacheStats(), { entries: 0, bytes: 0 });
  }, { launchGate });
});

test('optical security: rendered character counts and truncation cover the actual paginated text', async () => {
  await withRenderer(async (optical) => {
    const short = 'synthetic text 😀';
    const complete = await optical.renderTextToPages(short);
    assert.equal(complete.truncated, false);
    assert.equal(complete.pages.reduce((sum, page) => sum + page.chars, 0), short.length);
    const long = '字'.repeat(100_000);
    const limited = await optical.renderTextToPages(long, { maxPages: 1 });
    assert.equal(limited.truncated, true);
    assert.ok(limited.pages.reduce((sum, page) => sum + page.chars, 0) < long.length);
  });
});
