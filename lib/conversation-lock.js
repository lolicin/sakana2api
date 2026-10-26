'use strict';

const { abortError } = require('./abort');

class ConversationLocks {
  constructor({ maxQueued = 1000, timeoutMs = 60000 } = {}) {
    this.maxQueued = maxQueued;
    this.timeoutMs = timeoutMs;
    this.entries = new Map();
    this.closed = false;
  }

  get size() { return this.entries.size; }

  async acquire(key, { signal } = {}) {
    if (this.closed) throw Object.assign(new Error('server is shutting down'), { code: 'SERVER-SHUTDOWN' });
    if (signal?.aborted) throw abortError(signal.reason);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { queue: [] };
      this.entries.set(key, entry);
      return this._release(key, entry);
    }
    if (entry.queue.length >= this.maxQueued) {
      throw Object.assign(new Error('conversation queue full'), { code: 'QUEUE_FULL', status: 429 });
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, settled: false, timer: null, cleanup: null };
      const cancel = (error) => {
        if (waiter.settled) return;
        waiter.settled = true;
        waiter.cleanup();
        const index = entry.queue.indexOf(waiter);
        if (index !== -1) entry.queue.splice(index, 1);
        reject(error);
      };
      const onAbort = () => cancel(abortError(signal.reason));
      waiter.cleanup = () => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', onAbort);
      };
      waiter.timer = setTimeout(() => cancel(abortError({ code: 'REQUEST-TIMEOUT' })), this.timeoutMs);
      entry.queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  _release(key, entry) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const waiter of entry.queue.splice(0, 1)) {
        waiter.settled = true;
        waiter.cleanup();
        waiter.resolve(this._release(key, entry));
        return;
      }
      if (this.entries.get(key) === entry) this.entries.delete(key);
    };
  }

  close() {
    this.closed = true;
    for (const entry of this.entries.values()) {
      for (const waiter of entry.queue.splice(0)) {
        waiter.settled = true;
        waiter.cleanup();
        waiter.reject(Object.assign(new Error('server is shutting down'), { code: 'SERVER-SHUTDOWN' }));
      }
    }
  }
}

module.exports = { ConversationLocks };
