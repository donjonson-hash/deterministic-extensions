import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeUtf8Bytes, encodeUtf8Text, UTF8_CODEC_VERSION} from '../src/core/utf8.mjs';
import {decodeUtf8, encodeUtf8, makeDocument} from '../src/core/documents.mjs';

test('shared UTF-8 codec separates one file marker and preserves exact view bytes', () => {
  assert.equal(UTF8_CODEC_VERSION, 'utf8-v1');
  const bytes = Uint8Array.of(0xff, 0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf,
    0x61, 0x0d, 0x0a, 0xf0, 0x9f, 0x98, 0x80, 0x0d, 0x62, 0x0a, 0xff);
  const view = bytes.subarray(1, bytes.length - 1);
  const decoded = decodeUtf8Bytes(view);
  assert.deepEqual(decoded, {raw:'\uFEFFa\r\n😀\rb\n', bom:true});
  assert.deepEqual(encodeUtf8Text(decoded.raw, decoded.bom), view);
  bytes[7] = 0x7a;
  assert.equal(decoded.raw, '\uFEFFa\r\n😀\rb\n', 'decoded text is independent of later source mutations');
  assert.deepEqual(decodeUtf8Bytes(Uint8Array.of(0xef, 0xbb, 0xbf)), {raw:'', bom:true});
  assert.deepEqual(decodeUtf8Bytes(new Uint8Array()), {raw:'', bom:false});
});

test('shared UTF-8 decoder refuses malformed sequences rather than losing bytes', () => {
  for (const bytes of [[0xc0,0xaf], [0xed,0xa0,0x80], [0xf4,0x90,0x80,0x80],
    [0xef,0xbb], [0xc2], [0x80], [0xff], [0xef,0xbb,0xbf,0xff]]) {
    assert.throws(() => decodeUtf8Bytes(Uint8Array.from(bytes)), TypeError);
    assert.throws(() => decodeUtf8(Uint8Array.from(bytes)), {code:'invalid-document'});
  }
  for (const value of [[], new ArrayBuffer(2), new DataView(new ArrayBuffer(2)), 'text', null]) {
    assert.throws(() => decodeUtf8Bytes(value), TypeError);
  }
});

test('conversion policy stays separate from strict document bounds and validation', () => {
  const raw = 'x'.repeat(200001) + '\0\r\n';
  assert.equal(decodeUtf8Bytes(encodeUtf8Text(raw)).raw, raw);
  assert.throws(() => decodeUtf8(encodeUtf8Text(raw)), {code:'limit-exceeded'});
  assert.throws(() => decodeUtf8(new Uint8Array(1048577)), {code:'limit-exceeded'});
  assert.deepEqual(encodeUtf8Text('\ud800'), Uint8Array.of(0xef,0xbf,0xbd));
  assert.throws(() => makeDocument('\ud800'), {code:'invalid-document'});
  assert.throws(() => encodeUtf8({raw:'\ud800',bom:false}), {code:'invalid-document'});
  assert.throws(() => encodeUtf8Text(123), TypeError);
  assert.throws(() => encodeUtf8Text('text', 1), TypeError);
});
