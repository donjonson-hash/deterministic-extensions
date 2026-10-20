import {canonicalJson, freezeJson} from './canonical.mjs';
import {makeDocument, validateDocument, sameDocument} from './documents.mjs';

export const SESSION_LIMITS = Object.freeze({historyEntries: 50, acceptedCommands: 2048, commandIdLength: 128});
const exactKeys = (object, keys) => object && !Array.isArray(object)
  && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= SESSION_LIMITS.commandIdLength;
const detach = value => JSON.parse(canonicalJson(value));
const snapshot = value => freezeJson(detach(value));

function validateSession(state) {
  canonicalJson(state);
  if (!exactKeys(state, ['schemaVersion', 'a', 'b', 'revision', 'aRevision', 'bRevision', 'past', 'future', 'consumedIds'])
      || state.schemaVersion !== 1 || ![state.revision, state.aRevision, state.bRevision].every(validRevision)
      || state.revision !== state.aRevision + state.bRevision) throw new TypeError('Invalid session state');
  validateDocument(state.a); validateDocument(state.b);
  for (const history of [state.past, state.future]) {
    if (!Array.isArray(history) || history.length > SESSION_LIMITS.historyEntries) throw new TypeError('Invalid session history');
    history.forEach(validateDocument);
  }
  if (state.past.length + state.future.length > SESSION_LIMITS.historyEntries) throw new TypeError('Invalid combined session history');
  if (!Array.isArray(state.consumedIds) || state.consumedIds.length !== state.revision
      || state.consumedIds.length > SESSION_LIMITS.acceptedCommands
      || state.consumedIds.some(id => !validId(id)) || new Set(state.consumedIds).size !== state.consumedIds.length) {
    throw new TypeError('Invalid consumed-command state');
  }
}

export function createSession({a = makeDocument(), b = makeDocument()} = {}) {
  validateDocument(a); validateDocument(b);
  return snapshot({schemaVersion: 1, a, b, revision: 0, aRevision: 0, bRevision: 0,
    past: [], future: [], consumedIds: []});
}

export function prepareUseA(state, id) {
  validateSession(state);
  if (!validId(id)) throw new TypeError('A proposal requires a nonempty bounded command id');
  return snapshot({schemaVersion: 1, type: 'use-a', id, expectedRevision: state.revision,
    aRevision: state.aRevision, bRevision: state.bRevision, source: state.a, target: state.b});
}

// Reduction is atomic and returns the input state unchanged on rejection/no-op.
// The input may be a validated JSON-deserialized snapshot; identity is irrelevant.
export function reduceSession(state, command) {
  validateSession(state);
  const reject = status => Object.freeze({state, status});
  try {
    canonicalJson(command);
    if (!command || !validId(command.id) || !validRevision(command.expectedRevision)) return reject('invalid');
    const common = ['id', 'type', 'expectedRevision'];
    if (command.type === 'replace-a' || command.type === 'replace-b') {
      if (!exactKeys(command, [...common, 'document'])) return reject('invalid');
      validateDocument(command.document);
    } else if (command.type === 'use-a') {
      if (!exactKeys(command, [...common, 'schemaVersion', 'aRevision', 'bRevision', 'source', 'target'])
          || command.schemaVersion !== 1 || !validRevision(command.aRevision) || !validRevision(command.bRevision)) return reject('invalid');
      validateDocument(command.source); validateDocument(command.target);
    } else if (command.type === 'undo' || command.type === 'redo') {
      if (!exactKeys(command, common)) return reject('invalid');
    } else return reject('invalid');
  } catch (error) { return reject(error.code === 'limit-exceeded' ? 'limit-exceeded' : 'invalid'); }

  if (state.consumedIds.includes(command.id)) return reject('already-applied');
  if (command.expectedRevision !== state.revision) return reject('stale');
  if (command.type === 'use-a' && (command.aRevision !== state.aRevision || command.bRevision !== state.bRevision
      || !sameDocument(command.source, state.a) || !sameDocument(command.target, state.b))) return reject('stale');

  let next;
  if (command.type === 'replace-a') {
    if (sameDocument(state.a, command.document)) return reject('no-change');
    next = {...state, a: command.document, aRevision: state.aRevision + 1};
  } else if (command.type === 'replace-b' || command.type === 'use-a') {
    const document = command.type === 'use-a' ? command.source : command.document;
    if (sameDocument(state.b, document)) return reject('no-change');
    next = {...state, b: document, bRevision: state.bRevision + 1,
      past: [...state.past, state.b].slice(-SESSION_LIMITS.historyEntries), future: []};
  } else if (command.type === 'undo') {
    if (!state.past.length) return reject('no-change');
    next = {...state, b: state.past.at(-1), bRevision: state.bRevision + 1,
      past: state.past.slice(0, -1), future: [...state.future, state.b]};
  } else {
    if (!state.future.length) return reject('no-change');
    next = {...state, b: state.future.at(-1), bRevision: state.bRevision + 1,
      past: [...state.past, state.b].slice(-SESSION_LIMITS.historyEntries), future: state.future.slice(0, -1)};
  }
  if (state.consumedIds.length >= SESSION_LIMITS.acceptedCommands) return reject('limit-exceeded');
  next.revision = state.revision + 1;
  next.consumedIds = [...state.consumedIds, command.id];
  return Object.freeze({state: snapshot(next), status: 'applied'});
}
