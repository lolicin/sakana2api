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

/** Resolve a state path to its final write target, following symlinks even
 *  when the target does not exist yet (dangling) or loops (defensive cap). */
function resolveStateTarget(file) {
  let current = file;
  for (let hops = 0; hops < MAX_LINK_HOPS; hops += 1) {
    let stat;
    try { stat = fs.lstatSync(current); } catch { return current; }
    if (!stat.isSymbolicLink()) return current;
    let link;
    try { link = fs.readlinkSync(current); } catch { return current; }
    current = path.isAbsolute(link) ? link : path.resolve(path.dirname(current), link);
  }
  return current;
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
