'use strict';

const crypto = require('crypto');

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 32);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function messageFingerprint(messages = []) {
  return digest(JSON.stringify(canonical(messages)));
}

function firstFingerprint(messages = []) {
  const first = messages.find((m) => m && m.role === 'user');
  return digest(JSON.stringify(canonical(first || null)));
}

function recentFingerprint(messages = []) {
  return messageFingerprint(messages);
}

function makeContextSnapshot(normalized = {}) {
  const messages = Array.isArray(normalized.messages) ? normalized.messages : [];
  const snapshot = {
    firstMessageFingerprint: firstFingerprint(messages),
    recentClientHistoryFingerprint: messageFingerprint(messages),
    recentUserFingerprint: messageFingerprint(messages.filter((m) => m && m.role === 'user')),
    messageCount: messages.length,
    updatedAt: Date.now(),
  };
  if (typeof normalized.model === 'string') snapshot.model = normalized.model;
  for (const key of ['inputTokens', 'contextTokens']) {
    if (Number.isFinite(normalized[key])) snapshot[key] = normalized[key];
  }
  return snapshot;
}

function firstUserFingerprint(messages = []) {
  return firstFingerprint(messages);
}

function isKnownHistory(stored = {}, client = {}) {
  return !!stored?.recentClientHistoryFingerprint &&
    stored.recentClientHistoryFingerprint === client?.recentClientHistoryFingerprint;
}

function reuseDecision(stored) {
  return {
    action: 'reuse',
    conversationId: stored.conversationId,
    lastMessageId: stored.lastMessageId || '',
    sendClientHistory: false,
  };
}

function decideContext({ explicitId = '', stored = null, client = {}, historyMode = '', mode = '', history_mode = '' } = {}) {
  const requestedMode = String(historyMode || history_mode || mode || client.historyMode || client.history_mode || client.mode || 'full').toLowerCase();
  if (requestedMode !== 'delta') return { action: 'new', reason: 'FULL_HISTORY' };
  if (!explicitId) return { action: 'error', reason: 'CONTEXT_ID_REQUIRED' };
  if (!stored?.conversationId || (stored.conversationId !== explicitId && !(stored.clientConversationIds || []).includes(explicitId))) {
    return { action: 'error', reason: 'CONTEXT_EXPIRED' };
  }
  if (stored.model && client.model && stored.model !== client.model) {
    return { action: 'error', reason: 'CONTEXT_MODEL_MISMATCH' };
  }
  return reuseDecision(stored);
}

module.exports = { digest, messageFingerprint, firstFingerprint, recentFingerprint, firstUserFingerprint, makeContextSnapshot, isKnownHistory, decideContext };
