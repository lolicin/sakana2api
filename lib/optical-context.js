// Optical context compression (DeepSeek-OCR "contexts optical compression"
// idea): render long context text into columnar page images so a multimodal
// model reads N chars of text from far fewer tokens. The paper reports ~97%
// decoding precision below 10x compression and ~60% at 20x on a dedicated
// OCR model; the upstream here is a general VLM, so the default density stays
// conservative and is calibrated by scripts/bench_optical.mjs.
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { abortError } = require('./abort');

const RENDER_TIMEOUT_MS = Math.max(2000, parseInt(process.env.OPTICAL_RENDER_TIMEOUT_MS || '20000', 10));
const MAX_PAGE_BYTES = Math.max(64 * 1024, parseInt(process.env.OPTICAL_MAX_PAGE_BYTES || String(4 * 1024 * 1024), 10));
const IDLE_CLOSE_MS = Math.max(5000, parseInt(process.env.OPTICAL_IDLE_CLOSE_MS || '60000', 10));

// Density presets: text→pixel ratios. Per-page capacity = columns × rows ×
// chars-per-row; older pages may use denser presets (memory-decay schedule).
const DENSITY_PRESETS = {
  low: { columns: 1, fontSizePx: 16, lineHeight: 1.5, widthPx: 1024, rows: 42 },
  medium: { columns: 2, fontSizePx: 12, lineHeight: 1.4, widthPx: 1280, rows: 62 },
  high: { columns: 3, fontSizePx: 10, lineHeight: 1.3, widthPx: 1600, rows: 82 },
};

function charsPerPage(preset) {
  // CJK glyph width ≈ fontSizePx; average mixed-script width ≈ 0.75×size.
  const charsPerRow = Math.floor((preset.widthPx / preset.columns) / (preset.fontSizePx * 0.75));
  return charsPerRow * preset.rows * preset.columns;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Split text into page chunks without splitting surrogate pairs.
function paginate(text, perPage, maxPages) {
  const pages = [];
  let cursor = 0;
  while (cursor < text.length && pages.length < maxPages) {
    let end = Math.min(cursor + perPage, text.length);
    if (end < text.length) {
      // Back off to a sentence/whitespace boundary when close by.
      const window = text.slice(Math.max(cursor, end - 400), end);
      const cut = Math.max(window.lastIndexOf('。'), window.lastIndexOf('.'), window.lastIndexOf('\n'), window.lastIndexOf(' '));
      if (cut > 0) end = Math.max(cursor, end - 400) + cut + 1;
    }
    pages.push(text.slice(cursor, end));
    cursor = end;
  }
  return { pages, truncated: cursor < text.length };
}

function pageHtml(chunk, preset, index, total) {
  return `<div class="page" id="page-${index}">
  <div class="cols" style="column-count:${preset.columns};width:${preset.widthPx}px;font-size:${preset.fontSizePx}px;line-height:${preset.lineHeight}">${escapeHtml(chunk)}</div>
  <div class="footer" style="width:${preset.widthPx}px">context_page 第 ${index + 1} / ${total} 页</div>
</div>`;
}

// Single shared headless browser; first render pays the launch cost, later
// renders reuse the instance. Closed after an idle window.
let browserPromise = null;
let browser = null;
let idleTimer = null;
let renderChain = Promise.resolve();
let rendererGeneration = 0;
const renderJobs = new Set();
const pendingRenders = new Map();
const renderContexts = new Set();

function rendererError(code, message) {
  return Object.assign(new Error(message), { code, errorCode: code });
}

function armIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!browser || renderJobs.size) return;
  idleTimer = setTimeout(() => { closeRenderer().catch(() => {}); }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

async function getBrowser() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (browser) return browser;
  if (!browserPromise) {
    const generation = rendererGeneration;
    const launchRenderer = async () => {
      try {
        return await chromium.launch({ headless: true, timeout: RENDER_TIMEOUT_MS });
      } catch (error) {
        const fallback = resolveChromiumPath();
        if (fallback) return chromium.launch({ headless: true, executablePath: fallback, timeout: RENDER_TIMEOUT_MS });
        throw error;
      }
    };
    const launch = launchRenderer().then(async (instance) => {
      if (generation !== rendererGeneration) {
        await instance.close().catch(() => {});
        throw rendererError('SERVER-SHUTDOWN', 'renderer closed');
      }
      browser = instance;
      return instance;
    });
    browserPromise = launch;
    launch.catch(() => { if (browserPromise === launch) browserPromise = null; });
  }
  return browserPromise;
}

async function closeRenderer() {
  rendererGeneration++;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const reason = rendererError('SERVER-SHUTDOWN', 'renderer closed');
  const jobs = [...renderJobs];
  for (const job of jobs) job.controller.abort(reason);
  pendingRenders.clear();
  renderCache.clear();
  renderCacheBytes = 0;
  const closing = browser;
  const launching = browserPromise;
  browser = null;
  browserPromise = null;
  await Promise.all([
    ...[...renderContexts].map((context) => context.close().catch(() => {})),
    closing?.close().catch(() => {}),
    launching?.catch(() => {}),
    ...jobs.map((job) => job.promise.catch(() => {})),
  ]);
}

function resolveChromiumPath() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  // playwright Docker images keep full chromium under PLAYWRIGHT_BROWSERS_PATH
  // (default /ms-playwright); usable when only the headless shell is missing.
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.platform === 'win32' ? null : '/ms-playwright');
  if (browsersPath) {
    try {
      for (const entry of fs.readdirSync(browsersPath)) {
        if (entry.startsWith('chromium-')) {
          candidates.push(path.join(browsersPath, entry, 'chrome-linux', 'chrome'));
        }
      }
    } catch {}
  }
  if (process.platform === 'win32') {
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe');
  } else {
    candidates.push('/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome');
  }
  for (const candidate of candidates) {
    try { if (candidate && fs.existsSync(candidate)) return candidate; } catch {}
  }
  return null;
}

// Render-result LRU: writer-profile follow-up turns usually carry an
// identical old-context portion, and re-rendering byte-identical PNG pages
// costs a full browser pass (~1-2s) every turn. Keyed by text+layout so only
// genuinely new content pays the render cost.
function cacheLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
const RENDER_CACHE_MAX_BYTES = cacheLimit('OPTICAL_RENDER_CACHE_BYTES', 64 * 1024 * 1024);
const RENDER_CACHE_MAX_ENTRIES = cacheLimit('OPTICAL_RENDER_CACHE_ENTRIES', 128);
const renderCache = new Map(); // key -> { value, bytes }
let renderCacheBytes = 0;

function renderCacheKey(text, density, capped) {
  return require('crypto').createHash('sha256')
    .update(`${density}|${capped}|`).update(Buffer.from(String(text), 'utf8'))
    .digest('hex');
}

function renderCacheStore(key, value) {
  const bytes = value.pages.reduce((sum, p) => sum + p.buf.length, 0);
  if (bytes > RENDER_CACHE_MAX_BYTES || !RENDER_CACHE_MAX_ENTRIES || !RENDER_CACHE_MAX_BYTES) return;
  const previous = renderCache.get(key);
  if (previous) {
    renderCache.delete(key);
    renderCacheBytes -= previous.bytes;
  }
  while (renderCache.size && (renderCacheBytes + bytes > RENDER_CACHE_MAX_BYTES || renderCache.size >= RENDER_CACHE_MAX_ENTRIES)) {
    const oldest = renderCache.keys().next().value;
    renderCacheBytes -= renderCache.get(oldest).bytes;
    renderCache.delete(oldest);
  }
  renderCache.set(key, { value, bytes });
  renderCacheBytes += bytes;
}

/**
 * Render `text` into columnar PNG pages. The density schedule applies a
 * memory-decay style progression: pages are grouped into thirds that run
 * low → medium → high density, so the oldest text is the most compressed.
 * Returns { pages: [{ index, buf, chars, preset }], truncated, preset }.
 */
function renderAbortReason(signal) {
  return signal.reason?.code === 'OPTICAL_RENDER_TIMEOUT' ? signal.reason : abortError(signal.reason);
}

function checkRenderAbort(signal) {
  if (signal?.aborted) throw renderAbortReason(signal);
}

function waitForRender(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(renderAbortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(renderAbortReason(signal)); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

async function renderTextToPages(text, { density = 'medium', maxPages = 8, signal } = {}) {
  checkRenderAbort(signal);
  text = String(text);
  const capped = Math.max(1, Math.min(32, parseInt(maxPages, 10) || 8));
  const cacheKey = renderCacheKey(text, density, capped);
  const cached = renderCache.get(cacheKey);
  if (cached) {
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    return cached.value;
  }
  const pending = pendingRenders.get(cacheKey);
  // Requests with different abort lifetimes remain independent. Identical
  // un-signalled calls share one queued render and one cache insertion.
  if (pending && pending.parentSignal === signal) return waitForRender(pending.promise, signal);

  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const generation = rendererGeneration;
  const job = { controller, parentSignal: signal, promise: null };
  renderJobs.add(job);
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;

  // The task is a function, not a started promise. Browser work begins only
  // after the preceding render has closed its context.
  const task = async () => {
    checkRenderAbort(requestSignal);
    let context;
    const timer = setTimeout(() => controller.abort(rendererError('OPTICAL_RENDER_TIMEOUT',
      `optical render timed out after ${RENDER_TIMEOUT_MS}ms`)), RENDER_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = () => { if (context) context.close().catch(() => {}); };
    requestSignal.addEventListener('abort', onAbort, { once: true });
    try {
      const base = DENSITY_PRESETS[density] || DENSITY_PRESETS.medium;
      const mid = DENSITY_PRESETS.medium;
      const high = DENSITY_PRESETS.high;
      const schedule = [base, base, mid, mid, mid, high, high, high];
      const totalCapacity = schedule.slice(0, capped).reduce((sum, preset) => sum + charsPerPage(preset), 0);
      const { pages: chunks, truncated } = paginate(text, Math.max(400, Math.round(totalCapacity / capped)), capped);
      const total = chunks.length;
      const instance = await waitForRender(getBrowser(), requestSignal);
      checkRenderAbort(requestSignal);
      const creating = instance.newContext({ deviceScaleFactor: 1 }).then(async (created) => {
        if (requestSignal.aborted) {
          await created.close().catch(() => {});
          throw renderAbortReason(requestSignal);
        }
        return created;
      });
      context = await waitForRender(creating, requestSignal);
      renderContexts.add(context);
      const page = await waitForRender(context.newPage(), requestSignal);
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        body { margin: 0; background: #fff; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #111; }
        .page { margin: 0 auto; padding: 12px 0; }
        .cols { text-align: justify; word-break: break-word; }
        .footer { font-size: 10px; color: #888; margin-top: 6px; text-align: right; padding-right: 8px; }
      </style></head><body>
      ${chunks.map((chunk, index) => {
        const third = index / total;
        const preset = third < 1 / 3 ? schedule[0] : third < 2 / 3 ? schedule[2] : schedule[5];
        return pageHtml(chunk, preset, index, total);
      }).join('\n')}
      </body></html>`;
      await waitForRender(page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS }), requestSignal);
      const out = [];
      for (let index = 0; index < total; index++) {
        checkRenderAbort(requestSignal);
        const element = await waitForRender(page.$(`#page-${index}`), requestSignal);
        if (!element) continue;
        const buf = await waitForRender(element.screenshot({ type: 'png', timeout: RENDER_TIMEOUT_MS }), requestSignal);
        if (buf.length > MAX_PAGE_BYTES) {
          throw rendererError('OPTICAL_PAGE_TOO_LARGE', `optical page ${index + 1} exceeds ${MAX_PAGE_BYTES} bytes`);
        }
        out.push({ index, buf, chars: chunks[index].length, preset: index / total < 1 / 3 ? 'low' : index / total < 2 / 3 ? 'medium' : 'high' });
      }
      checkRenderAbort(requestSignal);
      const value = { pages: out, truncated: truncated || out.length !== total, density };
      if (generation === rendererGeneration) renderCacheStore(cacheKey, value);
      return value;
    } catch (error) {
      checkRenderAbort(requestSignal);
      throw error;
    } finally {
      clearTimeout(timer);
      requestSignal.removeEventListener('abort', onAbort);
      if (context) {
        await context.close().catch(() => {});
        renderContexts.delete(context);
      }
    }
  };
  job.promise = renderChain.then(task).finally(() => {
    renderJobs.delete(job);
    if (pendingRenders.get(cacheKey) === job) pendingRenders.delete(cacheKey);
    armIdleClose();
  });
  pendingRenders.set(cacheKey, job);
  renderChain = job.promise.then(() => {}, () => {});
  return waitForRender(job.promise, signal);
}

module.exports = {
  DENSITY_PRESETS,
  charsPerPage,
  renderTextToPages,
  closeRenderer,
  resolveChromiumPath,
  MAX_PAGE_BYTES,
  RENDER_TIMEOUT_MS,
  __renderCacheStats: () => ({ entries: renderCache.size, bytes: renderCacheBytes }),
};
