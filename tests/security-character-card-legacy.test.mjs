import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { parsePngCard } = require('../lib/character-card.js');
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
function chunk(type, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  header.write(type, 4);
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

test('PNG security: legacy IEND-appended JSON preserves leading whitespace', () => {
  const end = Buffer.alloc(8);
  end.write('IEND', 4);
  const card = { name: 'Synthetic' };
  const image = Buffer.concat([signature, chunk('IHDR', Buffer.alloc(13)), end, Buffer.from(` \n${JSON.stringify(card)}`)]);
  assert.deepEqual(parsePngCard(image).json, card);
});

test('PNG security: standard IEND CRC bytes do not consume the JSON metadata budget', () => {
  const json = JSON.stringify({ name: 'Synthetic', padding: '' });
  const padding = 'x'.repeat(1024 * 1024 - Buffer.byteLength(json));
  const card = { name: 'Synthetic', padding };
  const image = Buffer.concat([signature, chunk('IHDR', Buffer.alloc(13)), chunk('IEND'), Buffer.from(JSON.stringify(card))]);
  assert.deepEqual(parsePngCard(image).json, card);
});
