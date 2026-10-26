import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, test } from 'node:test';

const { normalizeRequestBody } = (await import('../lib/request-normalizer.js')).default;
const {
  buildNormalizedSakanaRequest, requestedHistoryMode, selectContextSuffix, selectNormalizedSuffix,
} = (await import('../lib/request-assembly.js')).default;

const priorThreshold = process.env.LONG_PROMPT_THRESHOLD;
process.env.LONG_PROMPT_THRESHOLD = '12000';
after(() => {
  if (priorThreshold === undefined) delete process.env.LONG_PROMPT_THRESHOLD;
  else process.env.LONG_PROMPT_THRESHOLD = priorThreshold;
});
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

for (const model of ['sakana-writer', 'sakana-code']) {
  for (const format of ['txt', 'json']) {
    for (const layout of ['latest-long', 'aggregate-long']) {
      test(`${model} ${format} ${layout} transports every canonical role, tool and earlier attachment`, async () => {
        const key = `${model}-${format}-${layout}`;
        const first = `EARLIER-FACT-${key}: the key is copper, never silver.`;
        const earlier = `HISTORY-BEGIN-${key}\n${'old chapter / source line\n'.repeat(layout === 'aggregate-long' ? 400 : 1)}HISTORY-END-${key}`;
        const latest = `LATEST-BEGIN-${key}\n${'new chapter / source line\n'.repeat(layout === 'latest-long' ? 700 : 1)}LATEST-END-${key}: continue using the copper key.`;
        const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
        const body = {
          model,
          context_format: format,
          conversation_id: 'client-opaque-id',
          messages: [
            { role: 'system', content: `SYSTEM-${key}: preserve all earlier facts.` },
            { role: 'developer', content: `DEVELOPER-${key}: follow the requested output format.` },
            { role: 'user', content: first },
            { role: 'assistant', content: [
              { type: 'text', text: earlier },
              { type: 'image_url', name: 'earlier.png', image_url: { url: `data:image/png;base64,${picture.toString('base64')}` } },
            ], tool_calls: [{ id: `call-${key}`, type: 'function', function: { name: 'lookup_history', arguments: JSON.stringify({ marker: `ARGUMENT-${key}` }) } }] },
            { role: 'tool', name: 'lookup_history', tool_call_id: `call-${key}`, content: `TOOL-RESULT-${key}: copper confirmed.` },
            { role: 'assistant', content: `ASSISTANT-${key}: keep that confirmation.\n${layout === 'aggregate-long' ? 'additional confirmed history\n'.repeat(200) : ''}` },
            { role: 'user', content: latest },
          ],
        };
        const normalized = await normalizeRequestBody(body);
        const assembled = buildNormalizedSakanaRequest(body, normalized, { conversationId: 'old-upstream', messageCount: 5 });
        const documents = assembled.sakanaReq.files.filter((file) => file.synthetic);
        assert.equal(documents.length, 1, 'aggregate canonical text triggers exactly one transport document');
        const text = documents[0].buf.toString('utf8');
        const documentText = format === 'json' ? JSON.stringify(JSON.parse(text)) : text;
        for (const marker of [`SYSTEM-${key}`, `DEVELOPER-${key}`, first, `HISTORY-BEGIN-${key}`, `HISTORY-END-${key}`, `call-${key}`, `ARGUMENT-${key}`, `TOOL-RESULT-${key}`, `ASSISTANT-${key}`, `LATEST-BEGIN-${key}`, `LATEST-END-${key}`, 'earlier.png']) {
          assert.ok(documentText.includes(marker), `packaged ${format} keeps ${marker}`);
        }
        if (format === 'txt') {
          assert.ok(text.includes(earlier) && text.includes(latest), 'both long blocks survive verbatim');
          assert.ok(text.indexOf('[系统]') < text.indexOf('[用户]') && text.indexOf('[助手]') < text.indexOf('[工具]'), 'role order survives');
        } else {
          const doc = JSON.parse(text);
          assert.equal(doc.schema, 'sakana-context/1');
          assert.ok(doc.system.includes(`SYSTEM-${key}`));
          assert.deepEqual(doc.turns.map((turn) => turn.role), ['developer', 'user', 'assistant', 'tool', 'assistant', 'user']);
          assert.ok(doc.turns[2].content.includes(earlier) && doc.turns.at(-1).content.includes(latest));
          assert.equal(doc.turns[3].name, 'lookup_history');
          assert.equal(doc.turns[3].tool_call_id, `call-${key}`);
          assert.ok(doc.turns[2].parts.some((part) => part.kind === 'tool_call' && part.id === `call-${key}`));
        }
        const attachments = assembled.sakanaReq.files.filter((file) => !file.synthetic);
        assert.equal(attachments.length, 1, 'earlier canonical attachment is sent once');
        assert.equal(attachments[0].name, 'earlier.png');
        assert.ok(attachments[0].buf.equals(picture));
        assert.equal(assembled.sakanaReq.conversationId, null, 'full history always starts a fresh upstream conversation');
        assert.equal(assembled.normalized, normalized, 'canonical graph is never sliced by stored counts');
      });
    }
  }
}

test('a full novel TXT contains the canonical role and exact complete source bytes', async () => {
  const novel = '第一章：潮汐把旧城的灯影揉碎。\n' + '海风穿过窗棂，记录员仍在等待下一封信。\n'.repeat(6000);
  const body = { model: 'sakana', messages: [{ role: 'user', content: novel }] };
  const assembled = buildNormalizedSakanaRequest(body, await normalizeRequestBody(body));
  const file = assembled.sakanaReq.files.find((entry) => entry.synthetic);
  assert.ok(file);
  assert.equal(digest(file.buf), digest(Buffer.from('[用户]\n' + novel)), 'transport includes exactly the full normalized message');
  assert.ok(file.buf.length > 200_000);
});

test('only explicit delta with a stored mapping reuses an upstream conversation', async () => {
  const messages = [
    { role: 'user', content: 'FIRST-EXACT-MARKER' },
    { role: 'assistant', content: 'ASSISTANT-EXACT-MARKER' },
    { role: 'user', content: 'LATEST-EXACT-MARKER' },
  ];
  for (const idKey of ['conversation_id', 'chat_id', 'thread_id']) {
    for (const mode of [undefined, 'full', 'delta']) {
      for (const stored of [null, { conversationId: 'stored-upstream', messageCount: 2 }]) {
        const body = { model: 'sakana', [idKey]: 'untrusted-client-id', history_mode: mode, messages };
        const normalized = await normalizeRequestBody(body);
        const assembled = buildNormalizedSakanaRequest(body, normalized, stored);
        assert.equal(assembled.sakanaReq.conversationId, mode === 'delta' && stored ? 'stored-upstream' : null, `${idKey}/${mode}/${!!stored}`);
        for (const marker of ['FIRST-EXACT-MARKER', 'ASSISTANT-EXACT-MARKER', 'LATEST-EXACT-MARKER']) {
          assert.ok(assembled.normalizedPrompt.includes(marker), 'no count-based slicing in either mode');
        }
        assert.equal(selectContextSuffix(body, stored), body);
        assert.equal(selectNormalizedSuffix(normalized, body, stored), normalized);
      }
    }
  }
  assert.equal(requestedHistoryMode({ conversation_id: 'opaque' }), 'full');
  assert.equal(requestedHistoryMode({ historyMode: 'DELTA' }), 'delta');
  assert.equal(requestedHistoryMode({ history_mode: 'unknown' }), 'full');
  const body = { history_mode: 'delta', messages: [{ role: 'user', content: 'delta only' }] };
  const assembled = buildNormalizedSakanaRequest(body, await normalizeRequestBody(body), { conversationId: 'mapped-upstream', messageCount: 100 });
  assert.equal(assembled.sakanaReq.conversationId, 'mapped-upstream', 'stored mapping can be supplied by a header lookup');
  assert.equal(assembled.normalizedPrompt, '[用户]\ndelta only');
});

test('canonical clipping and resolved attachments bypass all raw extraction', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const body = { model: 'sakana', messages: [{ role: 'user', content: [
    { type: 'text', text: 'KEEP-ME\n' + 'x'.repeat(14000) + 'RAW-TAIL-MUST-NOT-RETURN' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
  ] }] };
  const normalized = await normalizeRequestBody(body, { maxTextBytes: 100 });
  const assembled = buildNormalizedSakanaRequest(body, normalized);
  assert.equal(assembled.sakanaReq.files.length, 1, 'no raw file copy or oversized raw context document');
  assert.ok(assembled.sakanaReq.files[0].buf.equals(png));
  assert.equal(assembled.sakanaReq.files[0].name, normalized.attachments[0].name, 'resolved canonical filename is authoritative');
  assert.equal(assembled.sakanaReq.prompt.includes('RAW-TAIL-MUST-NOT-RETURN'), false);
  assert.ok(assembled.sakanaReq.prompt.includes('KEEP-ME'));
});

for (const format of ['txt', 'json']) {
  test(`user-owned context_document.${format} is retained and generated filenames avoid collisions`, async () => {
    const userBytes = Buffer.from('USER-OWNED-CONTEXT-DOCUMENT');
    const body = { model: 'sakana', context_format: format, messages: [{ role: 'user', content: [
      { type: 'text', text: 'LONG-START\n' + 'source material\n'.repeat(1500) + 'LONG-END' },
      { type: 'file', name: `context_document.${format}`, mime: 'text/plain', data: userBytes.toString('base64') },
      { type: 'file', name: `context_document-1.${format}`, mime: 'text/plain', data: Buffer.from('second user file').toString('base64') },
    ] }] };
    const normalized = await normalizeRequestBody(body);
    const assembled = buildNormalizedSakanaRequest(body, { ...normalized, attachments: [...normalized.attachments, normalized.attachments[0]] });
    assert.equal(assembled.sakanaReq.files.length, 3, 'canonical attachment IDs are sent once plus one synthetic file');
    const names = assembled.sakanaReq.files.map((file) => file.name);
    assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length, 'transport filenames are unambiguous');
    const userFile = assembled.sakanaReq.files.find((file) => file.name === `context_document.${format}`);
    assert.equal(userFile.synthetic, undefined);
    assert.ok(userFile.buf.equals(userBytes));
    const generated = assembled.sakanaReq.files.find((file) => file.synthetic);
    assert.ok(generated && generated.name.endsWith(`.${format}`));
    assert.equal(assembled.sakanaReq.contextDocumentName, generated.name, 'server can identify the generated transport document');
    assert.ok(assembled.sakanaReq.prompt.includes(generated.name), 'wrapper points to the generated filename');
    assert.equal(assembled.sakanaReq.attachments.length, 2, 'canonical attachments are unique as well');
  });
}

test('short canonical code requests keep the profile and tool contract once', async () => {
  const body = { model: 'sakana-code', messages: [
    { role: 'system', content: 'SYSTEM-EXACT' },
    { role: 'user', content: 'Return only a one-line diff.' },
  ], tools: [{ type: 'function', function: { name: 'read_project', description: 'READ-TOOL-EXACT', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }] };
  const assembled = buildNormalizedSakanaRequest(body, await normalizeRequestBody(body));
  const prompt = assembled.sakanaReq.prompt;
  assert.ok(prompt.includes('SYSTEM-EXACT') && prompt.includes('Return only a one-line diff.'));
  assert.ok(/代码|编程/.test(prompt), 'profile guidance survives canonical assembly');
  assert.equal(prompt.split('可用自定义工具列表').length - 1, 1);
  assert.equal(prompt.split('READ-TOOL-EXACT').length - 1, 1);
  assert.ok(prompt.includes('"tool"') && prompt.includes('"arguments"'));
});
