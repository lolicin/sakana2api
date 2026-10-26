// ContextStore — explicit conversation mappings owned by one request scope.
const crypto = require('node:crypto');

const TTL_DEFAULT = 24 * 60 * 60 * 1000;
const CAP_DEFAULT = 10000;
const CLIENT_ALIAS_CAP_DEFAULT = 16;
const PRUNE_INTERVAL_DEFAULT = 60 * 1000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const envNumber = (name, fallback, min = 0) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
};
const MAX_CLIENT_ALIAS_BYTES = 256;

const CLIENT_ALIAS_CAP = envNumber('CONTEXT_MAX_CLIENT_ALIASES', CLIENT_ALIAS_CAP_DEFAULT, 0);
const PRUNE_INTERVAL = envNumber('CONTEXT_PRUNE_MS', PRUNE_INTERVAL_DEFAULT, 0);

function lastUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => p && (p.text || p.content || '')).join(' ') : '');
  }
  return '';
}

function firstUserText(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    return typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => p && (p.text || p.content || '')).join(' ') : '');
  }
  return '';
}

function requestHeader(req, name) {
  const headers = req?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const key = headers[name] !== undefined ? name : Object.keys(headers).find((key) => key.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

function contextScope(req = {}) {
  let credentialScope;
  if (req?.contextScope !== undefined && req.contextScope !== null) credentialScope = String(req.contextScope);
  else if (req?.keyId !== undefined && req.keyId !== null && req.keyId !== '') credentialScope = `key:${req.keyId}`;
  else {
    const authorization = requestHeader(req, 'authorization');
    let token = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '').trim() : '';
    if (!token) {
      for (const name of ['x-goog-api-key', 'goog-api-key', 'x-api-key', 'api-key']) {
        const value = requestHeader(req, name);
        if (typeof value === 'string' && value.trim()) { token = value.trim(); break; }
      }
    }
    if (!token && typeof req?.query?.key === 'string') token = req.query.key;
    if (!token && req?.url) {
      try { token = new URL(req.url, 'http://context').searchParams.get('key') || ''; } catch {}
    }
    credentialScope = token ? `token:${sha(token)}` : 'open';
  }
  const explicitScope = requestHeader(req, 'x-client-session-id');
  return typeof explicitScope === 'string' && explicitScope.trim()
    ? `scoped:${sha(JSON.stringify([credentialScope, explicitScope.trim()]))}`
    : credentialScope;
}

function validateContextId(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > MAX_CLIENT_ALIAS_BYTES ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw Object.assign(new Error('context ID must be a nonempty string of at most 256 UTF8 bytes without controls'), {
      status: 400, code: 'CONTEXT_ID_INVALID',
    });
  }
  return value;
}

function explicitContextId(req, body) {
  const values = [body?.conversation_id, body?.chat_id, body?.thread_id,
    requestHeader(req, 'x-conversation-id'), requestHeader(req, 'x-thread-id')]
    .filter((value) => value !== undefined);
  for (const value of values) validateContextId(value);
  return values[0] ?? '';
}

const scopedKey = (scope, id) => `id:${JSON.stringify([scope, id])}`;

function getContextKeys(req, body) {
  if (typeof req === 'string') return [];
  const id = explicitContextId(req, body);
  return id ? [scopedKey(contextScope(req), id)] : [];
}

function snapshotFields(snapshot = {}, previous = {}) {
  const next = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const prior = previous && typeof previous === 'object' ? previous : {};
  const fields = {
    firstMessageFingerprint: next.firstMessageFingerprint || prior.firstMessageFingerprint || '',
    recentClientHistoryFingerprint: next.recentClientHistoryFingerprint || prior.recentClientHistoryFingerprint || '',
    recentUserFingerprint: next.recentUserFingerprint || prior.recentUserFingerprint || '',
    messageCount: Number.isFinite(next.messageCount) ? next.messageCount : (Number.isFinite(prior.messageCount) ? prior.messageCount : 0),
    updatedAt: next.updatedAt ?? prior.updatedAt ?? Date.now(),
    forks: Number.isFinite(next.forks) ? next.forks : (Number.isFinite(prior.forks) ? prior.forks : 0),
    rebuilds: Number.isFinite(next.rebuilds) ? next.rebuilds : (Number.isFinite(prior.rebuilds) ? prior.rebuilds : 0),
  };
  const model = typeof next.model === 'string' ? next.model : prior.model;
  if (typeof model === 'string') fields.model = model;
  for (const key of ['inputTokens', 'contextTokens']) {
    const value = Number.isFinite(next[key]) ? next[key] : prior[key];
    if (Number.isFinite(value)) fields[key] = value;
  }
  return fields;
}

function makeEntry(scope, conversationId, lastMessageId, accountId, snapshot, previous, aliases, now) {
  return {
    scope,
    conversationId,
    accountId: accountId || previous.accountId || '',
    clientConversationIds: aliases,
    lastMessageId: lastMessageId || previous.lastMessageId || '',
    ts: now,
    ...snapshotFields(snapshot, previous),
  };
}

function isContextEntry(entry) {
  return !!entry && typeof entry === 'object';
}

class ContextStore {
  constructor({ ttl = TTL_DEFAULT, capacity = CAP_DEFAULT, maxClientAliases = null,
    maxAliases = null, maxClientConversationIds = null, aliasCap = null,
    pruneIntervalMs = null, pruneInterval = null, now = Date.now, onPrune = null } = {}) {
    const aliasLimit = [maxClientAliases, maxAliases, maxClientConversationIds, aliasCap]
      .find(value => Number.isFinite(value));
    const pruneIntervalValue = [pruneIntervalMs, pruneInterval]
      .find(value => Number.isFinite(value));
    this.ttl = Math.max(0, Number.isFinite(ttl) ? ttl : TTL_DEFAULT);
    this.capacity = Math.max(0, Number.isFinite(capacity) ? capacity : CAP_DEFAULT);
    this.maxClientAliases = Math.max(0, Number.isFinite(aliasLimit) ? aliasLimit : CLIENT_ALIAS_CAP);
    this.pruneIntervalMs = Math.max(0, Number.isFinite(pruneIntervalValue) ? pruneIntervalValue : PRUNE_INTERVAL);
    this.now = typeof now === 'function' ? now : Date.now;
    this.onPrune = typeof onPrune === 'function' ? onPrune : null;
    this.map = new Map();
    this.stats = { sets: 0, hits: 0, misses: 0, evictions: 0 };
    this._pruneTimer = null;
    if (this.pruneIntervalMs > 0) this.startPruner();
  }

  get size() { return this.map.size; }

  _prune(now = this.now()) {
    let removed = 0;
    const groups = new Map();
    for (const [key, entry] of this.map) {
      if (!isContextEntry(entry) || !Number.isFinite(entry.ts) || now - entry.ts >= this.ttl) {
        this.map.delete(key);
        this.stats.evictions++;
        removed++;
        continue;
      }
      const groupKey = JSON.stringify([entry.scope || 'open', entry.conversationId]);
      let group = groups.get(groupKey);
      if (!group) {
        group = { ts: entry.ts, keys: [] };
        groups.set(groupKey, group);
      }
      group.ts = Math.min(group.ts, entry.ts);
      group.keys.push(key);
    }
    if (this.map.size > this.capacity) {
      const groupsByAge = [...groups.values()].sort((a, b) => a.ts - b.ts);
      for (const group of groupsByAge) {
        if (this.map.size <= this.capacity) break;
        for (const key of group.keys) {
          if (this.map.delete(key)) {
            this.stats.evictions++;
            removed++;
          }
        }
      }
    }
    if (removed && this.onPrune) {
      try { this.onPrune(removed); } catch {}
    }
    return removed;
  }

  /** Public expiry hook for callers that want deterministic cleanup. */
  prune(now = this.now()) {
    return this._prune(now);
  }

  expire(now = this.now()) {
    return this._prune(now);
  }

  startPruner(intervalMs = this.pruneIntervalMs) {
    this.stopPruner();
    this.pruneIntervalMs = Math.max(0, Number.isFinite(intervalMs) ? intervalMs : 0);
    if (this.pruneIntervalMs <= 0) return false;
    this._pruneTimer = setInterval(() => this._prune(this.now()), this.pruneIntervalMs);
    this._pruneTimer.unref?.();
    return true;
  }

  stopPruner() {
    if (!this._pruneTimer) return false;
    clearInterval(this._pruneTimer);
    this._pruneTimer = null;
    return true;
  }

  _get(key, now = this.now()) {
    const entry = this.map.get(key);
    if (entry && isContextEntry(entry) && Number.isFinite(entry.ts) && now - entry.ts < this.ttl) return entry;
    if (entry) {
      this.map.delete(key);
      this.stats.evictions++;
    }
    return null;
  }

  lookup(req, body) {
    if (typeof req !== 'string') {
      for (const key of getContextKeys(req, body)) {
        const entry = this._get(key);
        if (entry && entry.scope === contextScope(req)) { this.stats.hits++; return entry; }
      }
    }
    this.stats.misses++;
    return null;
  }

  getByConversationId(conversationId, req = {}) {
    if (!conversationId) return null;
    const scope = contextScope(req);
    const entry = this._get(scopedKey(scope, conversationId));
    return entry && entry.scope === scope && entry.conversationId === conversationId ? entry : null;
  }

  /** Remove only the owning scope's upstream ID and client aliases. */
  clearConversation(conversationId = '', req = {}) {
    if (!conversationId) return 0;
    const scope = contextScope(req);
    const entry = this._get(scopedKey(scope, conversationId));
    if (!entry || entry.scope !== scope) return 0;
    let removed = 0;
    for (const [key, candidate] of this.map) {
      if (!isContextEntry(candidate) || candidate.scope !== scope || candidate.conversationId !== entry.conversationId) continue;
      this.map.delete(key);
      removed++;
    }
    return removed;
  }

  updateLeaf(conversationId, lastMessageId, snapshot = null, req = {}) {
    if (!conversationId) return 0;
    const scope = contextScope(req);
    const now = this.now();
    let updated = 0;
    for (const [key, entry] of this.map) {
      if (!isContextEntry(entry) || entry.scope !== scope || entry.conversationId !== conversationId) continue;
      if (!this._get(key, now)) continue;
      this.map.set(key, {
        ...entry,
        ...snapshotFields(snapshot, entry),
        lastMessageId: lastMessageId || entry.lastMessageId || '',
        ts: now,
      });
      updated++;
    }
    return updated;
  }

  list(req = {}) {
    const scope = contextScope(req);
    const now = this.now();
    const entries = new Map();
    for (const [key] of this.map) {
      const entry = this._get(key, now);
      if (entry && entry.scope === scope) entries.set(entry.conversationId, entry);
    }
    return [...entries.values()];
  }

  _pruneAliases(scope, conversationId, aliases = []) {
    const allowed = new Set([scopedKey(scope, conversationId), ...aliases.map((id) => scopedKey(scope, id))]);
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (!isContextEntry(entry) || entry.scope !== scope || entry.conversationId !== conversationId || allowed.has(key)) continue;
      this.map.delete(key);
      removed++;
    }
    return removed;
  }

  save(req, body, conversationId, lastMessageId, explicitAccountId = null, snapshot = null) {
    if (typeof req === 'string' || !conversationId) return;
    validateContextId(conversationId);
    const scope = contextScope(req);
    const explicitId = explicitContextId(req, body);
    const snapshotAliases = Array.isArray(snapshot?.clientConversationIds) ? snapshot.clientConversationIds : [];
    for (const alias of snapshotAliases) validateContextId(alias);
    const now = this.now();
    const key = scopedKey(scope, conversationId);
    const current = this._get(key, now);
    // Neither an upstream ID nor a client alias can take another owner's key.
    if (current && current.conversationId !== conversationId) return;
    const previous = current || {};
    const candidates = [...new Set([...(previous.clientConversationIds || []), ...snapshotAliases,
      ...(explicitId ? [explicitId] : [])])];
    const aliases = candidates.filter((id) => {
      if (id === conversationId) return false;
      const owner = this._get(scopedKey(scope, id), now);
      return !owner || owner.conversationId === conversationId;
    });
    const retained = this.maxClientAliases > 0 ? aliases.slice(-this.maxClientAliases) : [];
    const entry = makeEntry(scope, conversationId, lastMessageId, explicitAccountId, snapshot, previous, retained, now);
    this._pruneAliases(scope, conversationId, retained);
    this.map.set(key, entry);
    for (const alias of retained) this.map.set(scopedKey(scope, alias), entry);
    this.stats.sets++;
    if (this.map.size > this.capacity) this._prune(now);
  }

  clear() { this.map.clear(); }

  close() {
    this.stopPruner();
    this.clear();
  }

  stop() { this.close(); }
}

module.exports = {
  ContextStore,
  contextScope,
  explicitContextId,
  firstUserText,
  lastUserText,
  getContextKeys,
};
