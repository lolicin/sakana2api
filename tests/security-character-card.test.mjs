import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { parsePngCard } = require('../lib/character-card.js');
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const metadataLimit = 1024 * 1024;
const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Synthetic', description: 'bounded metadata' } };
const json = Buffer.from(JSON.stringify(card));

function chunk(type, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length);
  header.write(type, 4);
  // CRC is not inspected by the metadata parser.
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}
function png(type, data) {
  return Buffer.concat([signature, chunk('IHDR', Buffer.alloc(13)), chunk(type, data), chunk('IEND')]);
}
function textChunk(type, text, compressed = false) {
  if (type === 'tEXt') return png(type, Buffer.concat([Buffer.from('chara\0'), text]));
  if (type === 'zTXt') return png(type, Buffer.concat([Buffer.from('chara\0\0'), zlib.deflateSync(text)]));
  return png(type, Buffer.concat([
    Buffer.from('chara\0'), Buffer.from([compressed ? 1 : 0, 0]),
    Buffer.from('en\0Synthetic\0'), compressed ? zlib.deflateSync(text) : text,
  ]));
}

for (const [type, compressed] of [['tEXt', false], ['zTXt', true], ['iTXt', false], ['iTXt', true]]) {
  for (const encoding of ['raw', 'base64']) {
    test(`PNG security: preserves ${type} ${compressed ? 'compressed' : 'plain'} ${encoding} cards`, () => {
      const bytes = encoding === 'raw' ? json : Buffer.from(json.toString('base64'));
      const image = textChunk(type, bytes, compressed);
      const parsed = parsePngCard(image);
      assert.deepEqual(parsed.json, card);
      assert.equal(parsed.spec, 'v2');
      assert.equal(parsed.png, image);
    });
  }
}

for (const type of ['tEXt', 'zTXt', 'iTXt']) {
  test(`PNG security: ${type} metadata expansion is bounded to 1 MiB`, () => {
    const text = Buffer.from(JSON.stringify({ name: 'Synthetic', description: 'x'.repeat(metadataLimit) }));
    assert.throws(() => parsePngCard(textChunk(type, text, true)), { code: 'CARD_METADATA_TOO_LARGE' });
  });
}

test('PNG security: inflateSync receives an output bound before inflation', () => {
  const image = textChunk('zTXt', json, true);
  const original = zlib.inflateSync;
  let called = false;
  zlib.inflateSync = function (input, options) {
    called = true;
    assert.equal(options?.maxOutputLength, metadataLimit);
    return original.call(this, input, options);
  };
  try {
    assert.deepEqual(parsePngCard(image).json, card);
    assert.equal(called, true);
  } finally {
    zlib.inflateSync = original;
  }
});

test('PNG security: legacy and standard IEND-appended JSON remain readable and bounded', () => {
  for (const crc of [Buffer.alloc(0), Buffer.alloc(4)]) {
    const end = Buffer.alloc(8);
    end.write('IEND', 4);
    const prefix = Buffer.concat([signature, chunk('IHDR', Buffer.alloc(13)), end, crc]);
    assert.deepEqual(parsePngCard(Buffer.concat([prefix, json])).json, card);
    const large = Buffer.from(JSON.stringify({ name: 'Synthetic', description: 'x'.repeat(metadataLimit) }));
    assert.throws(() => parsePngCard(Buffer.concat([prefix, large])), { code: 'CARD_METADATA_TOO_LARGE' });
  }
});
