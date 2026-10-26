// Local-only theme/responsive regression. Run with UI_SCREENSHOT_DIR to retain visual artifacts.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const screenshotDir = process.env.UI_SCREENSHOT_DIR;
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
const series = Array.from({ length: 24 }, (_, i) => ({ hourStr: `${String(i).padStart(2, '0')}:00`, requests: [0, 3, 6, 12, 24][i % 5], promptTokens: 600 + (i % 7) * 1300, completionTokens: 160 + (i % 5) * 170, cost: .02 + i * .004 }));
const stats = { accounts: { total: 8, active: 6, limited: 1, expired: 1 }, requests: { total: 1248, ok: 1236, err: 12, avgMs: 842 }, tokens: { prompt: 128400, completion: 36400, total: 164800 }, cache: { size: 24, hitRate: '18%' }, timeSeries: { h24: series }, byModel: { sakana: { requests: 734, charsIn: 183400, charsOut: 56400 }, 'sakana-code': { requests: 380, charsIn: 142200, charsOut: 84000 } }, ops: { uptimeSec: 86400, mem: { rssMB: 128 }, contextCount: 18, concurrency: { inFlight: 2, queueLength: 0 } }, auditCount: 1248 };
const fixtures = {
  '/v1/models': { data: ['sakana', 'sakana-mini', 'sakana-code', 'sakana-code-mini', 'sakana-writer', 'sakana-writer-mini', 'sakana-translate', 'sakana-polite', 'sakana-osaka'].map(id => ({ id, description: '深度思考 · 完整上下文' })) },
  '/health': { ok: true, version: '0.21.0' },
  '/api/stats': stats,
  '/api/characters': { characters: [], active: null },
  '/api/accounts': { accounts: [{ suid: 'fixture-1', email: 'demo@example.test', status: 'active', successCount: 12, errorCount: 0, inFlight: 1 }], total: 8, active: 6, target: 8, max: 10 },
  '/api/keys': { keys: [{ id: 'demo-key', name: 'Local client', prefix: 'sk-sak-demo', enabled: true }], open: true },
  '/api/audit': { entries: [{ id: 'fixture-request', ts: 1792972800000, method: 'POST', path: '/v1/chat/completions', model: 'sakana', status: 200, duration: 842 }] },
  '/api/mail-config': { provider: 'yyds', apiBase: 'https://mail.example.test/v1', domain: 'example.test', hasKey: true, keyPreview: 'AC-…' },
};
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html.replace('</head>', '<script>window.__themeBeforeBody = {theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.documentElement).backgroundColor};</script></head>')); }
  else if (path === '/favicon.ico') { res.writeHead(204); res.end(); }
  else { res.writeHead(fixtures[path] ? 200 : 404, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixtures[path] || {})); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const errors = [], external = [], screenshots = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await context.route('**/*', route => {
  if (!route.request().url().startsWith(origin)) { external.push(route.request().url()); return route.abort(); }
  return route.continue();
});
context.on('page', page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
});
await context.addInitScript(() => {
  const strokes = [], labels = [];
  window.__chartPaint = { strokes, labels };
  const stroke = CanvasRenderingContext2D.prototype.stroke;
  CanvasRenderingContext2D.prototype.stroke = function (...args) { strokes.push(this.strokeStyle); return stroke.apply(this, args); };
  const fillText = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (...args) { labels.push(this.fillStyle); return fillText.apply(this, args); };
});
const page = await context.newPage();
const capture = async name => {
  if (!screenshotDir) return;
  const path = `${screenshotDir}/${name}.png`;
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  screenshots.push(path);
};
const themeState = () => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, scheme: getComputedStyle(document.documentElement).colorScheme, bg: getComputedStyle(document.body).backgroundColor, stored: localStorage.getItem('sakana_theme'), toggles: [...document.querySelectorAll('[data-theme-toggle]')].map(el => el.getAttribute('aria-pressed')), choice: document.querySelector('[data-theme-choice].active')?.dataset.themeChoice }));
const checkTheme = async theme => {
  const state = await themeState();
  assert.equal(state.theme, theme);
  assert.equal(state.scheme, theme);
  assert.equal(state.bg, theme === 'dark' ? 'rgb(27, 26, 24)' : 'rgb(250, 249, 245)');
  assert(state.toggles.every(value => value === String(theme === 'dark')));
  assert.equal(state.choice, theme);
};
const navigate = async tab => {
  if (await page.locator('#btnOpenSidebar').isVisible()) await page.click('#btnOpenSidebar');
  await page.click(`.sidebar-nav [data-tab="${tab}"]`);
  await page.locator(`[data-pane="${tab}"]`).waitFor({ state: 'visible' });
};
const checkWidth = async () => {
  const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert(size.scroll <= size.width + 1, `horizontal page overflow: ${JSON.stringify(size)} at ${page.url()}`);
};

try {
  await page.goto(origin);
  await page.waitForSelector('#chatModelSelect option', { state: 'attached' });
  await checkTheme('light');
  await capture('desktop-light-dashboard');
  await page.locator('#btnHeaderTheme').focus();
  await page.keyboard.press('Enter');
  await checkTheme('dark');
  await page.reload();
  await page.waitForSelector('#chatModelSelect option', { state: 'attached' });
  await checkTheme('dark');
  assert.equal((await themeState()).stored, 'dark');
  assert.deepEqual(await page.evaluate(() => window.__themeBeforeBody), { theme: 'dark', bg: 'rgb(27, 26, 24)' });

  // Every CSS/JS custom property consumer must resolve in both palettes.
  const usedTokens = [...new Set([...html.matchAll(/(?:var\(|cssToken\(['"])(--[a-z0-9-]+)/g)].map(match => match[1]))];
  const palettes = {};
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => applyTheme(theme), theme);
    const palette = await page.evaluate(tokens => {
      const css = getComputedStyle(document.documentElement);
      const missing = tokens.filter(name => !css.getPropertyValue(name).trim());
      const color = name => {
        const probe = document.createElement('span'); probe.style.color = `var(${name})`; document.body.append(probe);
        const rgb = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map(Number); probe.remove(); return rgb;
      };
      const luminance = rgb => rgb.map(v => { const n = v / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
      const ratio = (a, b) => { const x = luminance(color(a)), y = luminance(color(b)); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      return { missing, text: Math.min(...['--bg', '--card', '--card-soft'].flatMap(bg => ['--text-main', '--text-dim', '--text-muted'].map(fg => ratio(bg, fg)))), button: Math.min(ratio('--on-accent', '--button-bg'), ratio('--on-accent', '--button-hover')), chart: css.getPropertyValue('--chart-line').trim(), label: css.getPropertyValue('--chart-label').trim(), colors: window.__chartPaint };
    }, usedTokens);
    assert.deepEqual(palette.missing, []);
    assert(palette.text >= 4.5, `${theme} text contrast ${palette.text}`);
    assert(palette.button >= 4.5, `${theme} button contrast ${palette.button}`);
    assert(palette.colors.strokes.some(value => value.toLowerCase() === palette.chart.toLowerCase()));
    assert(palette.colors.labels.some(value => value.toLowerCase() === palette.label.toLowerCase()));
    palettes[theme] = { textContrast: palette.text, buttonContrast: palette.button, chart: palette.chart };
  }
  await capture('desktop-dark-dashboard');
  const darkChart = await page.locator('#trendChart').evaluate(el => el.toDataURL());
  await page.click('#btnSidebarTheme');
  await checkTheme('light');
  assert.notEqual(await page.locator('#trendChart').evaluate(el => el.toDataURL()), darkChart, 'chart did not repaint on theme change');
  await page.click('#btnHeaderTheme');
  await page.click('#btnToggleSidebar');
  assert.equal(await page.locator('.main').evaluate(el => getComputedStyle(el).marginLeft), '0px');
  assert(await page.locator('#mainSidebar').evaluate(el => el.inert));
  await page.click('#btnToggleSidebar');
  assert.equal(await page.locator('.main').evaluate(el => getComputedStyle(el).marginLeft), '236px');

  await page.evaluate(() => localStorage.setItem('sakana_chat_sessions', JSON.stringify([{ id: 'visual-chat', title: 'Warm themes, clear thinking', createdAt: Date.now(), messages: [{ role: 'user', content: '请给我一个简洁的异步请求示例。', ts: Date.now() }, { role: 'assistant', content: '可以使用 `fetch` 发起请求。\n\n```js\nconst response = await fetch("/health");\nconst status = await response.json();\n```\n\n保持调用清晰，让界面安静地工作。', reasoning: '先确认接口，再处理返回结果。', citations: [{ title: 'API 接入文档', url: 'https://example.test/docs' }], ts: Date.now() }] }])));
  await page.reload();
  await navigate('chat');
  await capture('desktop-dark-chat');
  await page.click('#btnChatTheme');
  await checkTheme('light');
  await capture('desktop-light-chat');
  // A second tab changing the preference keeps all controls synchronized.
  const other = await context.newPage();
  await other.goto(origin);
  await other.click('#btnHeaderTheme');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await checkTheme('dark');
  await other.close();

  const widths = [390, 320, 768];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => applyTheme(theme), theme);
      for (const tab of ['dash', 'chat', 'models', 'accounts', 'keys', 'audit', 'docs', 'settings']) {
        await navigate(tab);
        await checkTheme(theme);
        await checkWidth();
        assert(await page.locator('#btnHeaderTheme').isVisible(), `theme unreachable from ${tab}`);
        if (tab === 'chat') {
          const send = await page.locator('#btnSendChat').boundingBox();
          assert(send.y + send.height <= 844, 'composer send button below viewport');
        }
        if (width === 390 && theme === 'dark' && ['dash', 'chat', 'settings'].includes(tab)) await capture(`mobile-dark-${tab}`);
        if (width === 390 && theme === 'light' && tab === 'chat') await capture('mobile-light-chat');
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => applyTheme('dark'));
  await page.click('#btnOpenSidebar');
  assert.equal(await page.locator('#btnOpenSidebar').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btnCloseSidebar');
  await page.locator('#mainSidebar a[href]').first().focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btnSidebarTheme');
  await page.keyboard.press('Space');
  await checkTheme('light');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btnOpenSidebar');
  assert(await page.locator('#mainSidebar').evaluate(el => el.inert));
  await navigate('chat');
  await page.click('#btnOpenChatDrawer');
  await page.locator('#btnChatSidebarTheme').focus();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btnChatSidebarTheme');
  await page.locator('#btnChatSidebarTheme').press('Enter');
  await checkTheme('dark');
  await capture('mobile-dark-chat-drawer');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'btnOpenChatDrawer');
  assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).overflow), 'visible');
  await page.click('#btnOpenSidebar');
  await capture('mobile-dark-navigation');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.waitForFunction(() => $('sidebarBackdrop').hidden && !$('mainSidebar').inert);
  assert(await page.locator('#sidebarBackdrop').isHidden());
  assert(!(await page.locator('#mainSidebar').evaluate(el => el.inert)));

  // Dialogs inherit the same palette, and invalid/blocked storage keeps the shell usable.
  await navigate('keys');
  await page.click('#btnOpenCreateKey');
  assert.equal(await page.locator('#createKeyModal .modal-box').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(36, 35, 32)');
  await page.click('#btnCloseKeyModal');
  await navigate('audit');
  await page.click('#auditRows button');
  await capture('desktop-dark-audit-dialog');
  await page.click('#btnCloseAuditModal');
  await page.evaluate(() => localStorage.setItem('sakana_theme', 'invalid'));
  await page.reload();
  await checkTheme('light');
  const blocked = await browser.newContext();
  await blocked.addInitScript(() => { const getItem = Storage.prototype.getItem, setItem = Storage.prototype.setItem; Storage.prototype.getItem = function (...args) { if (this === localStorage) throw new Error('storage blocked'); return getItem.apply(this, args); }; Storage.prototype.setItem = function (...args) { if (this === localStorage) throw new Error('storage blocked'); return setItem.apply(this, args); }; });
  const blockedPage = await blocked.newPage();
  const blockedErrors = [];
  blockedPage.on('pageerror', error => blockedErrors.push(error.message));
  await blockedPage.goto(origin);
  await blockedPage.click('#btnHeaderTheme');
  assert.equal(await blockedPage.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.deepEqual(blockedErrors, []);
  await blocked.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('UI theme passed:', JSON.stringify({ palettes, widths, screenshots }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
