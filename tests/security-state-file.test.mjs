import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { atomicWriteState, resolveStateTarget } = require('../lib/state-file.js');

for (const shape of ['self', 'pair', 'over-cap', 'parent']) {
  test(`state security: ${shape} loop throws before creating a temporary file`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sakana-state-security-'));
    try {
      const links = [];
      const count = shape === 'over-cap' ? 12 : shape === 'pair' ? 2 : 1;
      for (let index = 0; index < count; index++) links.push(path.join(root, `state-${index}`));
      for (let index = 0; index < count; index++) {
        fs.symlinkSync(path.basename(links[(index + 1) % count]), links[index], shape === 'parent' ? 'dir' : 'file');
      }
      const file = shape === 'parent' ? path.join(links[0], 'state.json') : links[0];
      assert.throws(() => atomicWriteState(file, '{"synthetic":true}'), { code: 'STATE_PATH_LOOP' });
      assert.throws(() => resolveStateTarget(file), { code: 'STATE_PATH_LOOP' });
      for (const link of links) assert.ok(fs.lstatSync(link).isSymbolicLink(), `${link} survives`);
      assert.deepEqual(fs.readdirSync(root).sort(), links.map((link) => path.basename(link)).sort());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('state security: normal, relative live and dangling targets remain writable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sakana-state-valid-'));
  try {
    const plain = path.join(root, 'plain.json');
    atomicWriteState(plain, 'plain');
    assert.equal(fs.readFileSync(plain, 'utf8'), 'plain');
    for (const live of [false, true]) {
      const dir = path.join(root, String(live));
      fs.mkdirSync(dir);
      const target = path.join(dir, 'runtime', 'state.json');
      if (live) {
        fs.mkdirSync(path.dirname(target));
        fs.writeFileSync(target, 'before');
      }
      const link = path.join(dir, 'state.json');
      fs.symlinkSync(path.join('runtime', 'state.json'), link, 'file');
      atomicWriteState(link, 'after');
      assert.equal(fs.readFileSync(target, 'utf8'), 'after');
      assert.ok(fs.lstatSync(link).isSymbolicLink());
      assert.ok(!fs.readdirSync(path.dirname(target)).some((name) => name.endsWith('.tmp')));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
