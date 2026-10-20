// Byte conversion only. Product adapters own size, text and document policies.
export const UTF8_CODEC_VERSION = 'utf8-v1';

export function decodeUtf8Bytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('UTF-8 input must be Uint8Array bytes');
  // Decode the exact view, retain all U+FEFF characters, then remove only the
  // first file marker. A second marker is text, not another encoding header.
  const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  const bom = text.startsWith('\uFEFF');
  return {raw: bom ? text.slice(1) : text, bom};
}

export function encodeUtf8Text(raw, bom = false) {
  if (typeof raw !== 'string' || typeof bom !== 'boolean') {
    throw new TypeError('UTF-8 output requires raw:string and bom:boolean');
  }
  // Standard TextEncoder behavior replaces unpaired UTF-16 surrogates with
  // U+FFFD. Strict document adapters must reject those strings before encoding.
  return new TextEncoder().encode((bom ? '\uFEFF' : '') + raw);
}
