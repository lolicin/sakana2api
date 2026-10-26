'use strict';

const { openaiRequestToSakana, normalizedMessagesToPrompt } = require('./translate');

function requestedHistoryMode(body = {}) {
  const mode = String(body.history_mode || body.historyMode || '').trim().toLowerCase();
  return mode === 'delta' ? 'delta' : 'full';
}

// Keep these compatibility helpers: full history and explicit deltas both
// carry exactly the canonical messages supplied by the caller, without slicing.
function selectContextSuffix(body = {}, stored = null) {
  return body;
}

function selectNormalizedSuffix(normalized = {}, body = {}, stored = null) {
  return normalized;
}

/**
 * Build the single upstream request shape used by all OpenAI-compatible routes.
 * Render the authoritative graph before translation applies route guidance,
 * long-context packaging and the visible client tool contract.
 */
function buildNormalizedSakanaRequest(body = {}, normalized = {}, stored = null) {
  const messages = Array.isArray(normalized.messages) ? normalized.messages : [];
  const normalizedPrompt = normalizedMessagesToPrompt(messages);
  const sakanaReq = openaiRequestToSakana(body, {
    normalizedPrompt,
    normalizedMessages: messages,
    attachments: Array.isArray(normalized.attachments) ? normalized.attachments : [],
  });
  sakanaReq.conversationId = requestedHistoryMode(body) === 'delta' ? (stored?.conversationId || null) : null;

  return { sakanaReq, normalizedPrompt, normalized, body };
}

module.exports = {
  requestedHistoryMode,
  selectContextSuffix,
  selectNormalizedSuffix,
  buildNormalizedSakanaRequest,
};
