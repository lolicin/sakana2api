// Character card id traversal guard: /api/characters/:id extracts ids from
// the URL and joins them into filesystem paths. The loadCard charset guard
// must turn ../-shaped ids into 404s instead of arbitrary-JSON reads
// (keys.json / session.json / account_pool.json all live one hop away).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadCard, saveCard } = require('../lib/character-card.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sakana-cards-'));
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

// Plant a secret one directory ABOVE the card dir to prove traversal cannot
// reach it (mirrors runtime/keys.json next to character_cards/).
const secretDir = path.join(tmp, 'parent');
const cardDir = path.join(secretDir, 'character_cards');
fs.mkdirSync(cardDir, { recursive: true });
fs.writeFileSync(path.join(secretDir, 'keys.json'), '[{"secret":"should-not-leak"}]');

const saved = saveCard(cardDir, { name: 'trav-guard' }, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

check('valid id loads', () => {
  const card = loadCard(cardDir, saved.id);
  assert.ok(card && card.name === 'trav-guard');
});

check('relative traversal id is rejected', () => {
  assert.equal(loadCard(cardDir, '../keys'), null);
  assert.equal(loadCard(cardDir, '../../parent/keys'), null);
});

check('encoded/absolute traversal ids are rejected', () => {
  assert.equal(loadCard(cardDir, '..%2F..%2Fkeys'), null);
  assert.equal(loadCard(cardDir, '/etc/passwd'.slice(0, 9)), null);
  assert.equal(loadCard(cardDir, 'C:\\\\Windows\\\\win'), null);
  assert.equal(loadCard(cardDir, ''), null);
  assert.equal(loadCard(cardDir, null), null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(passed === 3 ? 'character card traversal tests: all passed' : 'character card tests: FAILED');
