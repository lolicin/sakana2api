'use strict';

const dns = require('node:dns');
const net = require('node:net');
const { Agent } = require('undici');
const { abortError } = require('./abort');

const MAX_REDIRECTS = 5;
const redirects = new Set([301, 302, 303, 307, 308]);
const specialV4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) specialV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new net.BlockList();
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['2620:4f:8000::', 48], ['3fff::', 20],
]) specialV6.addSubnet(address, prefix, 'ipv6');

function remoteError(message, code = 'ATTACHMENT_INVALID_SOURCE') {
  return Object.assign(new Error(message), { code });
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !specialV4.check(address, 'ipv4');
  // Allow native global unicast only. This also rejects mapped IPv4,
  // translation/tunnel aliases, scoped, link-local and multicast addresses.
  return family === 6 && globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6');
}

function safeUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw remoteError('invalid attachment URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw remoteError('attachment URL must be http(s) without credentials');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')
    || host === 'internal' || host.endsWith('.internal') || host === 'local' || host.endsWith('.local')
    || (net.isIP(host) && !isPublicAddress(host))) {
    throw remoteError('attachment URL host not allowed');
  }
  return url;
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

// Use the vetted answers for every socket lookup for this hop. Resolving in
// the connector preserves global/custom fetch mocks while preventing a second
// DNS lookup between validation and connection (including Happy Eyeballs).
function pinnedLookup(expectedHost, signal) {
  let addresses;
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const host = String(hostname).replace(/\.$/, '').toLowerCase();
    if (host !== expectedHost) return callback(remoteError('attachment lookup host changed'));
    if (signal?.aborted) return callback(abortError(signal.reason));
    addresses ||= new Promise((resolve, reject) => {
      dns.lookup(host, { all: true, verbatim: true }, (error, records) => {
        if (error) return reject(error);
        if (!Array.isArray(records) || !records.length || records.some((record) => !isPublicAddress(record.address))) {
          return reject(remoteError('attachment DNS destination not allowed'));
        }
        resolve(records.map(({ address, family }) => ({ address, family: net.isIP(address) })));
      });
    });
    addresses.then((records) => {
      if (signal?.aborted) return callback(abortError(signal.reason));
      const family = Number(options?.family) || 0;
      const selected = records.filter((record) => !family || record.family === family);
      if (!selected.length) return callback(remoteError('attachment DNS family unavailable'));
      if (options?.all) callback(null, selected.map((record) => ({ ...record })));
      else callback(null, selected[0].address, selected[0].family);
    }, (error) => callback(error));
  };
}

async function cancelBody(response) {
  try { await response?.body?.cancel?.(); } catch {}
}

function policyError(error) {
  for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth++) {
    if (cause.code === 'ATTACHMENT_INVALID_SOURCE') return cause;
  }
  return error;
}

// The consumer reads the final body while the caller's original deadline is
// still live. No credentials or caller-controlled transport options enter this
// helper. Dispatchers belong to one request/hop and are always destroyed.
async function withRemoteResponse(raw, { fetchRemote = globalThis.fetch, signal, headers = {}, method = 'GET', body } = {}, consume) {
  let url = safeUrl(raw);
  const initialOrigin = url.origin;
  for (let hop = 0; ; hop++) {
    checkAbort(signal);
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    const dispatcher = new Agent({
      connections: 1,
      pipelining: 1,
      connect: { lookup: pinnedLookup(host, signal) },
    });
    let response;
    const destroy = () => { Promise.resolve(dispatcher.destroy()).catch(() => {}); };
    signal?.addEventListener('abort', destroy, { once: true });
    try {
      const requestHeaders = { ...headers };
      if (url.origin !== initialOrigin) {
        for (const name of Object.keys(requestHeaders)) {
          if (/^(?:authorization|proxy-authorization|cookie|x-api-key)$/i.test(name)) delete requestHeaders[name];
        }
      }
      response = await fetchRemote(url.href, {
        method, body: url.origin === initialOrigin ? body : undefined,
        headers: requestHeaders, signal, dispatcher, redirect: 'manual',
        credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      checkAbort(signal);
      if (redirects.has(response?.status)) {
        const location = response.headers?.get?.('location');
        await cancelBody(response);
        if (!location || hop >= MAX_REDIRECTS) throw remoteError('attachment redirect limit exceeded', 'ATTACHMENT_FETCH_FAILED');
        let next;
        try { next = new URL(location, url); } catch { throw remoteError('invalid attachment redirect'); }
        url = safeUrl(next.href);
        continue;
      }
      return await consume(response);
    } catch (error) {
      if (signal?.aborted) throw abortError(signal.reason);
      throw policyError(error);
    } finally {
      signal?.removeEventListener('abort', destroy);
      await cancelBody(response);
      await dispatcher.destroy().catch(() => {});
    }
  }
}

async function fetchRemoteJson(raw, { fetchRemote = globalThis.fetch, signal, headers = {}, method = 'GET', body, maxBytes = 1024 * 1024 } = {}) {
  return withRemoteResponse(raw, { fetchRemote, signal, headers, method, body }, async (response) => {
    const declared = Number(response?.headers?.get?.('content-length') || 0);
    if (declared > maxBytes) {
      await cancelBody(response);
      throw remoteError('remote response exceeds size limit', 'ATTACHMENT_TOO_LARGE');
    }
    if (!response?.body?.getReader) {
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) throw remoteError('remote response exceeds size limit', 'ATTACHMENT_TOO_LARGE');
      return { status: response.status, ok: response.ok, body: JSON.parse(bytes.toString('utf8')) };
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        checkAbort(signal);
        const { value, done } = await reader.read();
        checkAbort(signal);
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw remoteError('remote response exceeds size limit', 'ATTACHMENT_TOO_LARGE');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return { status: response.status, ok: response.ok, body: JSON.parse(Buffer.concat(chunks, total).toString('utf8')) };
  });
}

module.exports = { withRemoteResponse, fetchRemoteJson, safeUrl };
