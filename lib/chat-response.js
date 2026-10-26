'use strict';

const { PassThrough } = require('node:stream');

async function chatResponse(body, request, handleChatBody) {
  const sink = new PassThrough();
  const headers = new Map();
  let receivedHeaders;
  const ready = new Promise((resolve) => { receivedHeaders = resolve; });
  sink.statusCode = 200;
  sink.headersSent = false;
  sink.setHeader = (name, value) => headers.set(String(name).toLowerCase(), value);
  sink.getHeader = (name) => headers.get(String(name).toLowerCase());
  sink.getHeaders = () => Object.fromEntries(headers);
  sink.writeHead = (status, values = {}) => {
    sink.statusCode = status;
    for (const [name, value] of Object.entries(values)) sink.setHeader(name, value);
    sink.headersSent = true;
    receivedHeaders();
    return sink;
  };
  sink.flushHeaders = () => {};
  const streaming = body.stream === true;
  const completed = handleChatBody(request, sink, { ...body, stream: streaming }).catch((error) => {
    receivedHeaders();
    sink.destroy(error);
  });
  // Attach the stream consumer before generation to respect backpressure even
  // when a non-stream response exceeds the stream's high-water mark.
  if (!streaming) {
    const chunks = [];
    for await (const chunk of sink) chunks.push(chunk);
    await completed;
    return readResult(JSON.parse(Buffer.concat(chunks).toString('utf8')), sink.statusCode);
  }
  await ready;
  if (sink.statusCode >= 400) {
    const chunks = [];
    for await (const chunk of sink) chunks.push(chunk);
    await completed;
    return readResult(JSON.parse(Buffer.concat(chunks).toString('utf8')), sink.statusCode);
  }
  const conversationId = sink.getHeader('x-conversation-id');
  if (conversationId && !request.__response?.headersSent) request.__response?.setHeader('x-conversation-id', conversationId);
  return (async function* () {
    const decoder = new TextDecoder();
    let pending = '';
    try {
      for await (const chunk of sink) {
        pending += decoder.decode(chunk, { stream: true });
        const blocks = pending.split('\n\n');
        pending = blocks.pop();
        for (const block of blocks) {
          const data = block.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
          if (!data || data === '[DONE]') continue;
          yield { event: 'chat.completion.chunk', data: JSON.parse(data) };
        }
      }
      await completed;
    } finally {
      if (!sink.readableEnded) {
        request.__controller?.abort(Object.assign(new Error('response consumer disconnected'), { code: 'REQUEST-ABORTED' }));
        sink.destroy();
      }
    }
  })();
}

function readResult(result, status) {
  if (result.error && status >= 400) {
    throw Object.assign(new Error(result.error.message), { code: result.error.code, errorCode: result.error.code, status });
  }
  const message = result.choices?.[0]?.message || {};
  return {
    content: message.content || '',
    reasoning: message.reasoning_content || '',
    conversationId: result.conversation_id,
    promptTokens: result.usage?.prompt_tokens || 0,
    completionTokens: result.usage?.completion_tokens || 0,
    toolCalls: message.tool_calls || [],
    finishReason: result.choices?.[0]?.finish_reason,
    error: result.error?.message,
  };
}

module.exports = { chatResponse };
