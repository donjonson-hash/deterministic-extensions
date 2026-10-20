import {canonicalJson} from './canonical.mjs';
import {decodeUtf8Bytes, encodeUtf8Text} from './utf8.mjs';

export const DOCUMENT_LIMITS = Object.freeze({maxBytes: 1048576, maxCodeUnits: 200000, maxLines: 4000});
const encoder = new TextEncoder();
const invalid = message => Object.assign(new TypeError(message), {code: 'invalid-document'});
const limit = message => Object.assign(new RangeError(message), {code: 'limit-exceeded'});

export function normalizedText(document) {
  validateDocument(document);
  return document.raw.replace(/\r\n|\r/g, '\n');
}

export function validateDocument(document) {
  canonicalJson(document);
  if (!document || Array.isArray(document) || Object.keys(document).length !== 2
      || !Object.hasOwn(document, 'bom') || !Object.hasOwn(document, 'raw')
      || typeof document.raw !== 'string' || typeof document.bom !== 'boolean') {
    throw invalid('A document must have exactly raw:string and bom:boolean');
  }
  if (!document.raw.isWellFormed()) throw invalid('Unpaired UTF-16 surrogates would lose bytes when encoded');
  if (document.raw.length > DOCUMENT_LIMITS.maxCodeUnits) throw limit('Document exceeds the UTF-16 length limit');
  if (document.raw.split(/\r\n|\r|\n/).length > DOCUMENT_LIMITS.maxLines) throw limit('Document exceeds the line limit');
  if (encoder.encode(document.raw).length + (document.bom ? 3 : 0) > DOCUMENT_LIMITS.maxBytes) throw limit('Document exceeds the UTF-8 byte limit');
  return document;
}

export function makeDocument(raw = '', bom = false) {
  return Object.freeze(validateDocument({raw, bom}));
}

export function decodeUtf8(bytes) {
  if (!(bytes instanceof Uint8Array)) throw invalid('decodeUtf8 requires Uint8Array bytes');
  if (bytes.byteLength > DOCUMENT_LIMITS.maxBytes) throw limit('File exceeds the UTF-8 byte limit');
  let decoded;
  try {
    decoded = decodeUtf8Bytes(bytes);
  } catch { throw invalid('File is not valid UTF-8'); }
  return makeDocument(decoded.raw, decoded.bom);
}

export function encodeUtf8(document) {
  validateDocument(document);
  return encodeUtf8Text(document.raw, document.bom);
}

export function sameDocument(a, b) {
  return a.raw === b.raw && a.bom === b.bom;
}
