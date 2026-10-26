'use strict';
// State-file path resolution for deployed runtime symlinks.
//
// Deployed state files (account_pool.json, session.json, keys.json,
// tempmail.json, tokens.json) are symlinks into the runtime dir so state
// survives release switches. fs.realpathSync() is NOT sufficient here: it
// throws ENOENT for dangling links (deploy creates the link before the state
// file exists) and ELOOP for self-referential leftovers, and a naive
// try/catch fallback then writes THROUGH the link path — the subsequent
// rename() replaces the symlink with a regular file inside the release tree,
// silently migrating state out of the runtime dir (the root cause behind
// every "pool/session lost after deploy" incident).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LINK_HOPS = 8;

/** Resolve live and dangling links before creating any temporary file.
 *  A loop or exhausted hop budget must never become a rename destination. */
function resolveStateTarget(file) {
  let current = file;
  let hops = 0;
  const visited = new Set();
  const loopError = () => Object.assign(new Error('state path contains a symlink loop'), { code: 'STATE_PATH_LOOP' });
  for (;;) {
    const absolute = path.resolve(current);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (visited.has(key)) throw loopError();
    visited.add(key);
    const root = path.parse(absolute).root;
    const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
    let prefix = root;
    let followed = false;
    // Inspect parent components too: on Windows a loop in a parent may
    // surface as ENOENT from lstat(leaf), rather than ELOOP.
    for (let index = 0; index < parts.length; index++) {
      prefix = path.join(prefix, parts[index]);
      let stat;
      try {
        stat = fs.lstatSync(prefix);
      } catch (error) {
        if (error.code === 'ELOOP') throw loopError();
        if (error.code === 'ENOENT') return current;
        throw error;
      }
      if (!stat.isSymbolicLink()) continue;
      if (hops++ >= MAX_LINK_HOPS) throw loopError();
      let link;
      try { link = fs.readlinkSync(prefix); } catch (error) {
        if (error.code === 'ELOOP') throw loopError();
        throw error;
      }
      const target = path.isAbsolute(link) ? link : path.resolve(path.dirname(prefix), link);
      current = path.join(target, ...parts.slice(index + 1));
      followed = true;
      break;
    }
    if (!followed) return current;
  }
}

/** Atomic JSON/text write that always lands on the resolved state target. */
function atomicWriteState(file, text) {
  const target = resolveStateTarget(file);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(target);
  const tmp = path.join(dir, `.${base}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, target);
    try { fs.chmodSync(target, 0o600); } catch {}
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

module.exports = { resolveStateTarget, atomicWriteState };
