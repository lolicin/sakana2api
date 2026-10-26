// Deterministic local UI smoke for the v0.15 refresh. It never contacts the
// production host or an upstream model; all browser API calls are mocked.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

const root = new URL('..', import.meta.url);
const html = await readFile(new URL('public/index.html', root), 'utf8');
const models = [
  { id: 'sakana', description: 'Sakana · 标准对话 · 深度思考' },
  { id: 'sakana-mini', description: 'Sakana Mini · 轻量快速 · 深度思考' },
  { id: 'sakana-code', description: 'Sakana Code · 编程 · 长思维链 · 工具强化 · 先搜后想' },
  { id: 'sakana-code-mini', description: 'Sakana Code Mini · 编程轻量 · 工具强化 · 先搜后想' },
  { id: 'sakana-writer', description: 'Sakana Writer · 超长文本写作 · 上下文压缩管线' },
  { id: 'sakana-writer-mini', description: 'Sakana Writer Mini · 写作轻量 · 上下文压缩管线' },
  { id: 'sakana-translate', description: 'Sakana Translate · 大批量翻译 · 格式保真 · 术语一致' },
  { id: 'sakana-polite', description: 'Sakana Polite · 敬语风格 · 深度思考' },
  { id: 'sakana-osaka', description: 'Sakana Osaka · Osaka 风格 · 深度思考' },
  { id: 'sakana-namazu-rp2', description: 'legacy roleplay model' },
];
const audit = [{ id: 'smoke-1', ts: Date.now(), method: 'POST', path: '/v1/chat/completions', model: 'sakana', status: 200, duration: 42, error: null }];
const requestBodies = [];
let chatRequests = 0;
let contextFailureCode = 'CONTEXT_EXPIRED';

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const body = (status, value, headers = {}) => {
    const text = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(text);
  };
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (url.pathname === '/v1/models') body(200, { object: 'list', data: models });
  else if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      chatRequests++;
      if (chatRequests === 1) {
        body(500, { error: { message: 'intentional attachment retry failure' } });
        return;
      }
      if (chatRequests === 4 || contextFailureCode === 'CONTEXT_MODEL_MISMATCH') {
        body(409, { error: { code: contextFailureCode, message: 'Conversation state cannot continue' } });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-conversation-id': 'smoke-conversation',
      });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chatRequests === 2 ? 'retry ok' : 'new turn ok' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  } else if (url.pathname.startsWith('/v1/conversations/') && url.pathname.endsWith('/stop')) body(200, { ok: true });
  else if (url.pathname === '/health') body(200, { ok: true });
  else if (url.pathname === '/api/stats') body(200, { accounts: {}, requests: {}, tokens: {}, cache: {}, timeSeries: { h24: [] }, byModel: {}, ops: {} });
  else if (url.pathname === '/api/characters') body(200, { characters: [], active: null });
  else if (url.pathname === '/api/accounts') body(200, { accounts: [], total: 0, active: 0, target: 0, max: 0 });
  else if (url.pathname === '/api/keys') body(200, { keys: [], open: true });
  else if (url.pathname === '/api/audit') body(200, { entries: audit });
  else if (url.pathname === '/api/mail-config') body(200, { provider: 'yyds', apiBase: 'https://maliapi.215.im/v1', domain: '', hasKey: true, keyPreview: 'AC-…' });
  else body(404, { error: { message: 'not found' } });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
page.on('console', message => {
  if (message.type() !== 'error') return;
  if (/Failed to load resource: the server responded with a status of (500|409)/i.test(message.text())) return;
  errors.push(`console: ${message.text()}`);
});

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chatModelSelect option', { state: 'attached' });

  const initial = await page.evaluate(() => ({
    noRemoteFonts: [...document.querySelectorAll('link')].every(link => !/fonts\.googleapis|fonts\.gstatic/.test(link.href)),
    panes: document.querySelectorAll('[data-pane]').length,
    tabs: document.querySelectorAll('[data-tab]').length,
    options: document.querySelectorAll('#chatModelSelect option').length,
    hasRpOption: [...document.querySelectorAll('#chatModelSelect option')].some(option => /rp|roleplay/i.test(option.value)),
    togglesRemoved: !document.getElementById('btnToggleSearch') && !document.getElementById('btnToggleThink'),
    badgeRemoved: !document.getElementById('chatModelBadge'),
    styleSelect: !!document.getElementById('chatStyleSelect'),
  }));
  if (!initial.noRemoteFonts || initial.panes < 8 || initial.tabs < 8 || initial.options !== 9 || initial.hasRpOption) throw new Error(`unexpected initial UI: ${JSON.stringify(initial)}`);
  if (!initial.togglesRemoved || !initial.badgeRemoved || !initial.styleSelect) throw new Error(`composer cleanup failed: ${JSON.stringify(initial)}`);

  const ranking = await page.evaluate(() => {
    renderModelRanks({});
    const emptyColumns = document.querySelector('#modelRankTbody td').colSpan;
    renderModelRanks({ sakana: { requests: 3, charsIn: 400, charsOut: 200, errCount: 1 }, 'sakana-mini': { requests: 1, charsIn: 80, charsOut: 40, errCount: 0 } });
    const table = document.getElementById('modelRankTbody').closest('table');
    const headers = [...table.querySelectorAll('th')].map(el => el.textContent);
    const rows = [...table.querySelectorAll('tbody tr')].map(row => [...row.cells].map(cell => cell.textContent.trim()));
    renderModelRanks({ sakana: { requests: 0 } });
    const zeroShare = document.querySelector('#modelRankTbody tr').lastElementChild.textContent;
    return { emptyColumns, headers, rows, zeroShare };
  });
  if (ranking.emptyColumns !== 5 || ranking.headers.join('|') !== '模型|请求数|Tokens|错误|请求占比' || ranking.rows.some(row => row.length !== 5)) throw new Error(`ranking columns misaligned: ${JSON.stringify(ranking)}`);
  if (!ranking.rows[0][0].includes('sakana') || ranking.rows[0].slice(1).join('|') !== '3|150|1|75.0%' || ranking.rows[1].slice(1).join('|') !== '1|30|0|25.0%' || ranking.zeroShare !== '0.0%') throw new Error(`ranking values incorrect: ${JSON.stringify(ranking)}`);

  await page.click('#btnOpenSidebar');
  if (!(await page.locator('#mainSidebar').evaluate(el => el.classList.contains('drawer-open')))) throw new Error('mobile drawer did not open');
  // The backdrop center is covered by the sidebar itself; users tap the
  // exposed area to the right of the 280px drawer.
  await page.click('#sidebarBackdrop', { position: { x: 340, y: 400 } });
  if (await page.locator('#sidebarBackdrop').isVisible()) throw new Error('drawer backdrop did not close');

  await page.click('#btnOpenSidebar');
  await page.click('[data-tab="settings"]');
  await page.click('#btnThemeLight');
  const theme = await page.evaluate(() => ({ selected: document.documentElement.dataset.theme, stored: localStorage.getItem('sakana_theme') }));
  if (theme.selected !== 'light' || theme.stored !== 'light') throw new Error(`theme persistence failed: ${JSON.stringify(theme)}`);

  // Tab pane survives a reload via the URL hash.
  await page.click('#btnOpenSidebar');
  await page.click('[data-tab="chat"]');
  const hash = await page.evaluate(() => location.hash);
  if (hash !== '#chat') throw new Error(`tab hash not synced: ${hash}`);

  // Chat drawer on narrow screens keeps the sidebar reachable.
  await page.click('#btnOpenChatDrawer');
  if (!(await page.locator('#chatSidebar').evaluate(el => el.classList.contains('chat-drawer-open')))) throw new Error('chat drawer did not open');

  // Custom presets persist in localStorage with an 8-item cap. The save
  // button lives inside the chat sidebar drawer.
  await page.fill('#chatInput', '帮我写一个爬虫');
  await page.click('#btnSavePreset');
  await page.click('#btnSavePreset');
  const customPresets = await page.evaluate(() => JSON.parse(localStorage.getItem('sakana_custom_presets') || '[]'));
  if (customPresets.length !== 2) throw new Error(`custom presets not saved: ${customPresets.length}`);
  await page.click('#chatDrawerBackdrop', { position: { x: 340, y: 400 } });
  if (await page.locator('#chatSidebar').evaluate(el => el.classList.contains('chat-drawer-open'))) throw new Error('chat drawer did not close');

  // Attachment retry lifecycle: fail → one-shot retry buffer → later turns clean.
  await page.setInputFiles('#fileUploadInput', {
    name: 'chapter.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('chapter attachment: ' + 'novel '.repeat(20)),
  });
  await page.waitForSelector('#attachmentsPreview', { state: 'visible' });
  await page.fill('#chatInput', '继续写这一章');
  await page.click('#btnSendChat');
  await page.waitForSelector('button[onclick*="retryLastChatMessage"]', { timeout: 10_000 });

  const afterFailure = await page.evaluate(() => {
    const stored = localStorage.getItem('sakana_chat_sessions') || '';
    return {
      storedHasDataUrl: stored.includes('data:'),
      domHasDataUrl: [...document.querySelectorAll('#chatMessages img')].some(img => img.src.startsWith('data:')),
      attachmentPreviewVisible: !document.getElementById('attachmentsPreview').hidden,
    };
  });
  if (afterFailure.storedHasDataUrl || afterFailure.domHasDataUrl || afterFailure.attachmentPreviewVisible) throw new Error(`attachment retained after failure: ${JSON.stringify(afterFailure)}`);
  if (requestBodies[0].history_mode !== 'full' || requestBodies[0].conversation_id) throw new Error('initial request must send authoritative full history');
  if (!requestBodies[0]?.messages?.some(message => JSON.stringify(message).includes('chapter.txt'))) throw new Error('first outbound request omitted attachment metadata');
  if (!JSON.stringify(requestBodies[0]).includes('data:text/plain;base64,')) throw new Error('first outbound request omitted Data URL');

  await page.click('button[onclick*="retryLastChatMessage"]');
  await page.waitForFunction(() => document.querySelector('#chatMessages')?.textContent.includes('retry ok'), null, { timeout: 10_000 });
  if (requestBodies[1].history_mode !== 'full' || requestBodies[1].conversation_id) throw new Error('no-ID retry must retain full-history mode');
  if (chatRequests !== 2 || !JSON.stringify(requestBodies[1]).includes('data:text/plain;base64,')) throw new Error('retry request did not carry its one-shot attachment');

  // Retry and new turns route style through the body, not removed toggles.
  if (requestBodies[1].web_search !== undefined || requestBodies[1].enable_thinking !== undefined) throw new Error('client still sends routing toggles');

  await page.fill('#chatInput', '开始下一回');
  await page.selectOption('#chatStyleSelect', 'osaka');
  await page.click('#btnSendChat');
  await page.waitForFunction(() => document.querySelector('#chatMessages')?.textContent.includes('new turn ok'), null, { timeout: 10_000 });
  // Full-context accounting: the tail usage chunk must surface in the
  // assistant meta line (input↑ / output↓ / Σ total / speed).
  await page.waitForFunction(() => {
    const metas = [...document.querySelectorAll('#chatMessages .msg-meta')];
    return metas.some((m) => m.textContent.includes('↑1,200') && m.textContent.includes('↓40') && m.textContent.includes('Σ 1,240') && m.textContent.includes('tok/s'));
  }, null, { timeout: 5_000 });
  if (requestBodies[2].style !== 'osaka') throw new Error(`style parameter missing: ${JSON.stringify(requestBodies[2]).slice(0, 120)}`);
  const thirdPayload = JSON.stringify(requestBodies[2]);
  if (chatRequests !== 3 || thirdPayload.includes('data:text/plain;base64,') || thirdPayload.includes('chapter attachment')) throw new Error('later turn resent released attachment');
  if (requestBodies[2].history_mode !== 'delta' || requestBodies[2].conversation_id !== 'smoke-conversation' || requestBodies[2].messages.length !== 1 || requestBodies[2].messages[0].content !== '开始下一回') throw new Error('continuation must send only the latest turn with an explicit scoped ID');

  await page.fill('#chatInput', '上下文已过期的下一回');
  await page.click('#btnSendChat');
  await page.waitForSelector('#chatMessages [role="alert"]');
  const expiredText = await page.locator('#chatMessages [role="alert"]').textContent();
  if (!expiredText.includes('完整历史') || !expiredText.includes('原始附件')) throw new Error(`expired context recovery guidance missing: ${expiredText}`);
  if (await page.locator('button[onclick*="retryLastChatMessage"]').count()) throw new Error('expired context must not offer a blind retry');
  await page.fill('#chatInput', '不能静默丢失历史');
  await page.click('#btnSendChat');
  if (chatRequests !== 4 || await page.inputValue('#chatInput') !== '不能静默丢失历史') throw new Error('expired session silently continued or consumed input');

  contextFailureCode = 'CONTEXT_MODEL_MISMATCH';
  await page.evaluate(() => {
    createNewChatSession();
    const session = chatSessions.find(s => s.id === activeConversationId);
    session.conversationId = 'different-model-conversation';
    saveChatSessions();
  });
  await page.selectOption('#chatModelSelect', 'sakana-code');
  await page.fill('#chatInput', '改用代码模型');
  await page.click('#btnSendChat');
  await page.waitForSelector('#chatMessages [role="alert"]');
  const mismatchText = await page.locator('#chatMessages [role="alert"]').textContent();
  if (!mismatchText.includes('模型不匹配') || !mismatchText.includes('新建聊天') || !mismatchText.includes('完整历史') || !mismatchText.includes('原始附件')) throw new Error(`model mismatch recovery guidance missing: ${mismatchText}`);
  if (await page.locator('button[onclick*="retryLastChatMessage"]').count()) throw new Error('model mismatch offered blind retry');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chatModelSelect option', { state: 'attached' });
  await page.fill('#chatInput', '保留下一条输入');
  await page.click('#btnSendChat');
  if (chatRequests !== 5 || await page.inputValue('#chatInput') !== '保留下一条输入') throw new Error('model mismatch recovery flag did not survive reload or consumed input');
  if (!(await page.locator('#toast').textContent()).includes('完整历史')) throw new Error('model mismatch guard lost recovery guidance after reload');

  await page.click('#btnOpenSidebar');
  await page.click('[data-tab="models"]');
  if (await page.locator('#modelMatrixGrid .model-card').count() !== 9) throw new Error('model matrix does not show the 9 standard models');

  const chat = await page.evaluate(() => {
    const sessions = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, title: `session ${i}`, messages: Array.from({ length: 20 }, () => ({ role: 'user', content: 'x'.repeat(5000), files: [{ name: 'x.png', type: 'image/png', dataUrl: 'data:image/png;base64,' + 'A'.repeat(2000) }] })) }));
    localStorage.setItem('sakana_chat_sessions', JSON.stringify(sessions));
    return { storedBeforeReload: localStorage.getItem('sakana_chat_sessions').length };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#chatModelSelect option', { state: 'attached' });
  const bounded = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('sakana_chat_sessions') || '[]');
    return { sessions: saved.length, messages: saved.reduce((n, s) => n + s.messages.length, 0), bytes: localStorage.getItem('sakana_chat_sessions').length, dataUrls: JSON.stringify(saved).includes('data:image') };
  });
  if (bounded.sessions > 20 || bounded.messages > 400 || bounded.bytes > 2 * 1024 * 1024 || bounded.dataUrls) throw new Error(`chat bounds failed: ${JSON.stringify(bounded)}`);
  if (!chat.storedBeforeReload) throw new Error('chat fixture was not written');

  await page.click('#btnOpenSidebar');
  await page.click('[data-tab="audit"]');
  await page.waitForSelector('#auditRows button');
  await page.click('#auditRows button');
  const auditText = await page.locator('#modalAuditReq').textContent();
  if (!auditText.includes('method') || auditText.includes('reqBody') || auditText.includes('resBody')) throw new Error(`audit detail is not metadata-only: ${auditText}`);

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('UI smoke passed:', JSON.stringify({ initial, theme, afterFailure, chatRequests, customPresets: customPresets.length, bounded }));
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
