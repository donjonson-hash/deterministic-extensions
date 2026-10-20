import {canonicalJson, freezeJson} from './canonical.mjs';
import {normalizedText, sameDocument} from './documents.mjs';

export const DEFAULT_POLICY = Object.freeze({id: 'line-index-v1', ignoreTrailingWhitespace: false});

export function compareDocuments(a, b, policy = DEFAULT_POLICY) {
  canonicalJson(policy);
  if (!policy || Object.keys(policy).length !== 2
      || !Object.hasOwn(policy, 'id') || !Object.hasOwn(policy, 'ignoreTrailingWhitespace')
      || policy.id !== DEFAULT_POLICY.id || typeof policy.ignoreTrailingWhitespace !== 'boolean') {
    throw new TypeError('Unsupported comparison policy');
  }
  const left = normalizedText(a).split('\n'), right = normalizedText(b).split('\n');
  const key = line => policy.ignoreTrailingWhitespace ? line.replace(/[\t ]+$/g, '') : line;
  const rows = [];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const aLine = index < left.length ? left[index] : null;
    const bLine = index < right.length ? right[index] : null;
    const kind = aLine === null ? 'added' : bLine === null ? 'removed' : key(aLine) === key(bLine) ? 'equal' : 'changed';
    rows.push({line: index + 1, a: aLine, b: bLine, kind});
  }
  const changes = rows.filter(row => row.kind !== 'equal');
  const equalText = changes.length === 0;
  const equalBytes = sameDocument(a, b);
  return freezeJson({policy: {...policy}, alignment: 'line-index', minimal: false,
    equalText, equalBytes, formatOnly: normalizedText(a) === normalizedText(b) && !equalBytes, rows, changes});
}
