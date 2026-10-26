// Regression tests for runtime state-file symlink persistence.
// Root cause this guards: atomic tmp+rename on a symlink path REPLACES the
// link (state silently migrates back into the release tree); the shared
// resolver must follow both live and DANGLING links (realpathSync throws
// ENOENT on the latter, which used to defeat the guard).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveStateTarget, atomicWriteState } = require('../lib/state-file.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sakana-state-'));
let passed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n${e && e.stack || e}`);
    process.exitCode = 1;
  }
}

// 1) live absolute symlink: write must land on the target, link preserved
check('live absolute symlink: writes through, link preserved', () => {
  const dirA = path.join(tmpRoot, 'a');
  const dirB = path.join(tmpRoot, 'b');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const target = path.join(dirB, 'account_pool.json');
  fs.writeFileSync(target, '{"v":0}');
  const link = path.join(dirA, 'account_pool.json');
  fs.symlinkSync(target, link);
  atomicWriteState(link, '{"v":1}');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"v":1}');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'symlink must survive the write');
  assert.ok(!fs.existsSync(path.join(dirA, '.account_pool.json')), 'no tmp litter');
});

// 2) dangling absolute symlink (deploy creates the link before state exists):
//    write must CREATE the runtime target, never replace the link
check('dangling absolute symlink: creates target, link preserved', () => {
  const dirA = path.join(tmpRoot, 'c');
  const dirB = path.join(tmpRoot, 'd');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const target = path.join(dirB, 'session.json'); // intentionally absent
  const link = path.join(dirA, 'session.json');
  fs.symlinkSync(target, link);
  atomicWriteState(link, '{"v":2}');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"v":2}');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'dangling symlink must survive');
});

// 3) relative symlink resolution (as deploy_v2's `ln -s runtime/x` creates)
check('relative symlink: resolves against link dir', () => {
  const dirA = path.join(tmpRoot, 'e');
  fs.mkdirSync(path.join(dirA, 'runtime'), { recursive: true });
  const link = path.join(dirA, 'keys.json');
  fs.symlinkSync(path.join('runtime', 'keys.json'), link);
  atomicWriteState(link, '[]');
  assert.equal(fs.readFileSync(path.join(dirA, 'runtime', 'keys.json'), 'utf8'), '[]');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});

// Cyclic paths must fail before rename can replace the symlink.
check('self-referential loop: write rejected, link preserved', () => {
  const dir = path.join(tmpRoot, 'f');
  fs.mkdirSync(dir, { recursive: true });
  const link = path.join(dir, 'tokens.json');
  fs.symlinkSync(link, link);
  assert.throws(() => resolveStateTarget(link), { code: 'STATE_PATH_LOOP' });
  assert.throws(() => atomicWriteState(link, '{}'), { code: 'STATE_PATH_LOOP' });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});

// 5) plain file path (no symlink): ordinary atomic write
check('plain file: ordinary atomic write', () => {
  const file = path.join(tmpRoot, 'plain.json');
  atomicWriteState(file, '{"v":3}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"v":3}');
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(passed === 5 ? 'state-file tests: all passed' : 'state-file tests: FAILED');
