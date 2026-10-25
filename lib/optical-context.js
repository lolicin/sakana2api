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

async function getBrowser() {
  if (browser) return browser;
  if (!browserPromise) {
    // Default headless uses the dedicated headless-shell build; when it is not
    // downloaded, fall back to the full chromium binary in new-headless mode.
    const launchRenderer = async () => {
      try {
        return await chromium.launch({ headless: true });
      } catch (error) {
        const fallback = resolveChromiumPath();
        if (fallback) return chromium.launch({ headless: true, executablePath: fallback });
        throw error;
      }
    };
    browserPromise = launchRenderer().then((instance) => {
      browser = instance;
      return instance;
    }).catch((error) => {
      browserPromise = null;
      throw error;
    });
    // Idle-close arming must swallow launch failures: browserPromise rejects
    // when chromium is missing, and a success-only .then() here would leave an
    // unhandled rejection that kills the whole server process.
    browserPromise.then(() => {
      idleTimer = setTimeout(() => {
        if (browser) {
          const closing = browser;
          browser = null;
          browserPromise = null;
          closing.close().catch(() => {});
        }
      }, IDLE_CLOSE_MS);
      idleTimer.unref?.();
    }, () => {});
  }
  return browserPromise;
}

function closeRenderer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const closing = browser;
  browser = null;
  browserPromise = null;
  if (closing) return closing.close().catch(() => {});
  return Promise.resolve();
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
const RENDER_CACHE_MAX_BYTES = Math.max(4 * 1024 * 1024,
  parseInt(process.env.OPTICAL_RENDER_CACHE_BYTES || String(64 * 1024 * 1024), 10));
const renderCache = new Map(); // key -> { value, bytes }
let renderCacheBytes = 0;

function renderCacheKey(text, density, capped) {
  return require('crypto').createHash('sha256')
    .update(`${density}|${capped}|`).update(Buffer.from(String(text), 'utf8'))
    .digest('hex');
}

function renderCacheStore(key, value) {
  const bytes = value.pages.reduce((sum, p) => sum + p.buf.length, 0);
  renderCache.set(key, { value, bytes });
  renderCacheBytes += bytes;
  while (renderCacheBytes > RENDER_CACHE_MAX_BYTES && renderCache.size > 1) {
    const oldest = renderCache.keys().next().value;
    const entry = renderCache.get(oldest);
    renderCache.delete(oldest);
    renderCacheBytes -= entry.bytes;
  }
}

/**
 * Render `text` into columnar PNG pages. The density schedule applies a
 * memory-decay style progression: pages are grouped into thirds that run
 * low → medium → high density, so the oldest text is the most compressed.
 * Returns { pages: [{ index, buf, chars, preset }], truncated, preset }.
 */
async function renderTextToPages(text, { density = 'medium', maxPages = 8, signal } = {}) {
  const base = DENSITY_PRESETS[density] || DENSITY_PRESETS.medium;
  const capped = Math.max(1, Math.min(32, parseInt(maxPages, 10) || 8));
  const baseCapacity = charsPerPage(base);
  // Estimate total capacity with the density schedule; the last third uses
  // the densest preset so old pages hold more text.
  const mid = DENSITY_PRESETS.medium;
  const high = DENSITY_PRESETS.high;
  const schedule = [base, base, mid, mid, mid, high, high, high];
  const totalCapacity = schedule.slice(0, capped).reduce((sum, p) => sum + charsPerPage(p), 0);
  const { pages: chunks, truncated } = paginate(text, Math.max(400, Math.round(totalCapacity / capped)), capped);
  const total = chunks.length;

  const renderTask = (async () => {
    const instance = await getBrowser();
    const context = await instance.newContext({ deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
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
      await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
      const out = [];
      for (let index = 0; index < total; index++) {
        if (signal?.aborted) {
          const error = new Error('request aborted');
          error.code = 'REQUEST-ABORTED';
          error.errorCode = 'REQUEST-ABORTED';
          throw error;
        }
        const element = await page.$(`#page-${index}`);
        if (!element) continue;
        const buf = await element.screenshot({ type: 'png', timeout: RENDER_TIMEOUT_MS });
        if (buf.length > MAX_PAGE_BYTES) {
          const error = new Error(`optical page ${index + 1} exceeds ${MAX_PAGE_BYTES} bytes`);
          error.code = 'OPTICAL_PAGE_TOO_LARGE';
          throw error;
        }
        out.push({ index, buf, chars: chunks[index].length, preset: index / total < 1 / 3 ? 'low' : index / total < 2 / 3 ? 'medium' : 'high' });
      }
      return { pages: out, truncated, density };
    } finally {
      await context.close().catch(() => {});
    }
  })();

  // Serialize renders through a single chain; drop the timeout race result
  // cleanly so a slow render does not leak the context.
  const cacheKey = renderCacheKey(text, density, capped);
  const cached = renderCache.get(cacheKey);
  if (cached) {
    // LRU bump: re-insert at the tail.
    renderCache.delete(cacheKey);
    renderCache.set(cacheKey, cached);
    return cached.value;
  }
  const chained = renderChain.then(() => renderTask).then((value) => {
    renderCacheStore(cacheKey, value);
    return value;
  });
  renderChain = chained.catch(() => {});
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`optical render timed out after ${RENDER_TIMEOUT_MS}ms`);
      error.code = 'OPTICAL_RENDER_TIMEOUT';
      reject(error);
    }, RENDER_TIMEOUT_MS + 2000);
    timer.unref?.();
  });
  return Promise.race([chained, timeout]).finally(() => {
    // keep renderer warm; closed by idle timer
  });
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
