'use strict';
// Token estimation for a hidden-tokenizer upstream (web chat API returns no
// usage). CJK-aware: CJK code points cost ~1 token each on mainstream
// tokenizers, while Latin averages ~4 chars/token — the previous flat /4
// under-counted Chinese prompts ~4x. Image attachments and optical context
// pages are estimated from pixel area (vision encoders scale with pixels,
// ~(w*h)/750 tokens, Claude-style), with a byte-based fallback for non-PNG.

const CJK_MIN = 0x2E80;
const CJK_RANGES = [
  [0x2E80, 0x2FDF], [0x3000, 0x303F], [0x3040, 0x30FF], [0x31F0, 0x31FF],
  [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xAC00, 0xD7AF], [0xF900, 0xFAFF], [0xFF00, 0xFFEF],
];
const CHARS_PER_LATIN_TOKEN = 4;
const PIXELS_PER_IMAGE_TOKEN = 750;
const MIN_IMAGE_TOKENS = 85;      // vision encoders floor tiny crops
const BYTES_PER_BINARY_TOKEN = 4; // raw binaries fall back to byte density

function isCjk(cp) {
  if (cp < CJK_MIN) return false;
  for (const [lo, hi] of CJK_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}

function estimateTokens(text) {
  if (text == null) return 0;
  const s = typeof text === 'string' ? text : String(text);
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < s.length; i += 1) {
    const cp = s.codePointAt(i);
    if (cp > 0xFFFF) i += 1;
    if (isCjk(cp)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.round(cjk + other / CHARS_PER_LATIN_TOKEN));
}

// PNG dimensions from the IHDR chunk (fixed layout after the 8-byte
// signature + 4-byte length + 4-byte type).
function pngDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  if (buf.readUInt32BE(12) !== 0x49484452) return null; // 'IHDR'
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function estimateImageTokens({ width, height, bytes } = {}) {
  if (width > 0 && height > 0) {
    return Math.max(MIN_IMAGE_TOKENS, Math.round((width * height) / PIXELS_PER_IMAGE_TOKEN));
  }
  if (bytes > 0) return Math.max(MIN_IMAGE_TOKENS, Math.round(bytes / 1500));
  return MIN_IMAGE_TOKENS;
}

/**
 * Estimate the upstream-context cost of one request file. Files are the
 * multipart parts actually sent upstream: text attachments and the optical
 * pipeline's context_document.txt / context_page-N.png artefacts.
 * Shape: { name|filename, buf|decoded, mime|type, pendingUrl? }.
 */
function estimateFileTokens(file) {
  if (!file) return 0;
  const name = String(file.name || file.filename || '');
  const buf = Buffer.isBuffer(file.buf) ? file.buf
    : Buffer.isBuffer(file.decoded) ? file.decoded
    : file.content != null ? Buffer.from(String(file.content), 'utf8')
    : null;
  if (file.pendingUrl && !buf) return MIN_IMAGE_TOKENS;
  const isPng = /^base64;context_page-\d+\.png$/.test(name) || /\.png$/i.test(name) || (buf && buf[0] === 0x89 && buf[1] === 0x50);
  if (isPng && buf) {
    const dims = pngDimensions(buf);
    return estimateImageTokens({ width: dims?.width, height: dims?.height, bytes: buf.length });
  }
  if (/^image\//.test(String(file.mime || '')) && buf) {
    return estimateImageTokens({ bytes: buf.length });
  }
  if (buf) {
    if (/[\x00-\x08\x0E-\x1F]/.test(buf.subarray(0, 512).toString('latin1'))) {
      return Math.max(1, Math.round(buf.length / BYTES_PER_BINARY_TOKEN));
    }
    return estimateTokens(buf.toString('utf8'));
  }
  return 0;
}

/**
 * Total input-side context estimate for an upstream request: the assembled
 * prompt plus every file part (attachments, optical pages, context tail).
 */
function estimateRequestTokens(sakanaReq = {}) {
  const promptTokens = estimateTokens(sakanaReq.prompt || '');
  let fileTokens = 0;
  for (const file of Array.isArray(sakanaReq.files) ? sakanaReq.files : []) {
    fileTokens += estimateFileTokens(file);
  }
  return { promptTokens, fileTokens, total: promptTokens + fileTokens };
}

/** Streaming variant: accumulate CJK/other counts per delta without keeping
 *  the full output text in memory. */
function createTokenCounter() {
  let cjk = 0;
  let other = 0;
  return {
    feed(text) {
      if (text == null) return;
      const s = typeof text === 'string' ? text : String(text);
      for (let i = 0; i < s.length; i += 1) {
        const cp = s.codePointAt(i);
        if (cp > 0xFFFF) i += 1;
        if (isCjk(cp)) cjk += 1;
        else other += 1;
      }
    },
    get tokens() {
      return Math.max(1, Math.round(cjk + other / CHARS_PER_LATIN_TOKEN));
    },
  };
}

module.exports = {
  estimateTokens,
  estimateFileTokens,
  estimateRequestTokens,
  estimateImageTokens,
  createTokenCounter,
  pngDimensions,
  CHARS_PER_LATIN_TOKEN,
  PIXELS_PER_IMAGE_TOKEN,
};
