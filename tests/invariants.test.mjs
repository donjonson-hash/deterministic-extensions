import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson} from '../src/core/canonical.mjs';
import {makeDocument, decodeUtf8, encodeUtf8, normalizedText} from '../src/core/documents.mjs';
import {compareDocuments, DEFAULT_POLICY} from '../src/core/comparison.mjs';
import {createSession, reduceSession, prepareUseA} from '../src/core/session.mjs';
import {createResultGate} from '../src/core/gates.mjs';

const roundtrip = value => JSON.parse(JSON.stringify(value));
const bytes = document => Array.from(encodeUtf8(document));
const replace = (state, side, document, id) => reduceSession(state, {
  id, type: `replace-${side}`, expectedRevision: state.revision, document
});
const move = (state, type, id) => reduceSession(state, {id, type, expectedRevision: state.revision});

test('UTF-8 roundtrip preserves BOM, mixed line endings, Unicode and final-newline distinctions', () => {
  const encoder = new TextEncoder();
  const fixtures = ['', '\n', 'first\r\nsecond\nthird\rfourth', 'Привет 🥭\r\nCafe\u0301', 'end', 'end\n'];
  for (const raw of fixtures) for (const bom of [false, true]) {
    const source = new Uint8Array([...(bom ? [239, 187, 191] : []), ...encoder.encode(raw)]);
    const document = decodeUtf8(source);
    assert.deepEqual(encodeUtf8(document), source);
    assert.equal(document.raw, raw);
    assert.equal(document.bom, bom);
  }
  assert.throws(() => decodeUtf8(new Uint8Array([0xc0, 0xaf])), /./);
  assert.throws(() => makeDocument('\ud800'), /./);
});

test('comparison separates normalized wording from exact export bytes', () => {
  const a = makeDocument('one\r\ntwo\r', true);
  const b = makeDocument('one\ntwo\n', false);
  assert.equal(normalizedText(a), normalizedText(b));
  const report = compareDocuments(a, b);
  assert.equal(report.equalText, true);
  assert.equal(report.equalBytes, false);
  assert.equal(report.formatOnly, true);
  assert.deepEqual(report.changes, []);
  assert.notDeepEqual(bytes(a), bytes(b));
  assert.equal(compareDocuments(makeDocument('end'), makeDocument('end\n')).equalText, false);
});

test('equal final A/B and policy yield equal comparison after different load/edit/history routes', () => {
  const a = makeDocument('item\r\nrepeat\r\nrepeat\r\nprice 25\r\n', true);
  const b = makeDocument('item\nrepeat\nprice 30\n', false);
  const direct = createSession({a, b});
  let route = createSession();
  route = replace(route, 'b', makeDocument('temporary'), 'route-1').state;
  route = replace(route, 'a', a, 'route-2').state;
  route = replace(route, 'b', b, 'route-3').state;
  route = move(route, 'undo', 'route-4').state;
  route = move(route, 'redo', 'route-5').state;
  assert.notEqual(route.revision, direct.revision);
  assert.equal(canonicalJson(compareDocuments(route.a, route.b)), canonicalJson(compareDocuments(direct.a, direct.b)));
  assert.deepEqual(bytes(route.b), bytes(direct.b));
  assert.equal(compareDocuments(route.a, route.b).minimal, false, 'line-index example must not promise a minimal diff');
});

test('serialized Use A has the same result and does not consult time or randomness', () => {
  const state = createSession({a: makeDocument('A\r\n', true), b: makeDocument('B\n')});
  const proposal = prepareUseA(state, 'transfer-1');
  const first = reduceSession(state, proposal);
  const expectedReport = canonicalJson(compareDocuments(state.a, state.b));
  const dateNow = Date.now, random = Math.random;
  let second;
  try {
    Date.now = () => { throw new Error('Wall clock is not a core input'); };
    Math.random = () => { throw new Error('Randomness is not a core input'); };
    second = reduceSession(roundtrip(state), roundtrip(proposal));
    assert.equal(canonicalJson(compareDocuments(state.a, state.b)), expectedReport);
  } finally { Date.now = dateNow; Math.random = random; }
  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'applied');
  assert.equal(canonicalJson(first.state), canonicalJson(second.state));
  assert.deepEqual(bytes(first.state.b), bytes(state.a));
  assert.equal(state.b.raw, 'B\n', 'the input snapshot is not mutated');
});

test('replaying the same displayed transfer is blocked even after Undo', () => {
  const original = createSession({a: makeDocument('A\r\n', true), b: makeDocument('B\n')});
  const proposal = roundtrip(prepareUseA(original, 'shown-transfer'));
  const applied = reduceSession(original, proposal);
  assert.equal(applied.status, 'applied');
  const duplicate = reduceSession(applied.state, proposal);
  assert.equal(duplicate.status, 'already-applied');
  assert.equal(duplicate.state, applied.state);
  const undone = move(applied.state, 'undo', 'undo-1');
  assert.equal(undone.status, 'applied');
  assert.deepEqual(bytes(undone.state.b), bytes(original.b));
  const replay = reduceSession(undone.state, roundtrip(proposal));
  assert.equal(replay.status, 'already-applied');
  assert.equal(replay.state, undone.state);
  assert.equal(reduceSession(undone.state, prepareUseA(undone.state, 'new-deliberate-transfer')).status, 'applied');
});

test('old transfer rejects A edits, B edits and raw-only changes without fuzzy repair', () => {
  const initial = createSession({a: makeDocument('a\nb'), b: makeDocument('c\nd')});
  const proposal = prepareUseA(initial, 'old-proposal');
  for (const [side, changed] of [
    ['a', makeDocument('changed')], ['b', makeDocument('changed')],
    ['a', makeDocument('a\r\nb')], ['b', makeDocument('c\nd', true)]
  ]) {
    const updated = replace(initial, side, changed, `update-${side}`).state;
    const rejected = reduceSession(updated, roundtrip(proposal));
    assert.equal(rejected.status, 'stale');
    assert.equal(rejected.state, updated);
    assert.ok(!updated.consumedIds.includes('old-proposal'));
  }
});

test('Undo and Redo restore exact raw B while revisions advance and new edits discard the redo branch', () => {
  const initial = createSession({a: makeDocument('alpha\r\nbeta\r', true), b: makeDocument('β\n🦀', false)});
  const changed = reduceSession(initial, prepareUseA(initial, 'use-a')).state;
  const undone = move(changed, 'undo', 'undo').state;
  const redone = move(undone, 'redo', 'redo').state;
  assert.deepEqual(bytes(undone.b), bytes(initial.b));
  assert.deepEqual(bytes(redone.b), bytes(changed.b));
  assert.ok(initial.revision < changed.revision && changed.revision < undone.revision && undone.revision < redone.revision);
  const branched = replace(undone, 'b', makeDocument('fresh\r\n', true), 'branch').state;
  assert.deepEqual(branched.future, []);
  assert.equal(move(branched, 'redo', 'empty-redo').status, 'no-change');
});

test('rejected and no-change commands leave document, consumed identities and history untouched', () => {
  const state = createSession({a: makeDocument('A'), b: makeDocument('B')});
  const commands = [
    [{id:'same', type:'replace-b', expectedRevision:0, document:makeDocument('B')}, 'no-change'],
    [{id:'old', type:'replace-b', expectedRevision:8, document:makeDocument('C')}, 'stale'],
    [{id:'malformed', type:'replace-b', expectedRevision:0, document:{raw:'B', bom:'yes'}}, 'invalid'],
    [{id:'oversize', type:'replace-b', expectedRevision:0, document:{raw:'x'.repeat(200001), bom:false}}, 'limit-exceeded'],
    [{id:'unknown', type:'delete-everything', expectedRevision:0}, 'invalid']
  ];
  const before = canonicalJson(state);
  for (const [command, status] of commands) {
    const result = reduceSession(state, command);
    assert.equal(result.status, status);
    assert.equal(result.state, state);
    assert.equal(canonicalJson(state), before);
  }
});

test('async gate rejects out-of-order, replayed, revision-stale and policy-stale results', () => {
  const gate = createResultGate();
  const old = gate.issue(0, canonicalJson(DEFAULT_POLICY));
  const recent = gate.issue(0, canonicalJson(DEFAULT_POLICY));
  assert.equal(gate.accept(old, 0, canonicalJson(DEFAULT_POLICY)), false);
  assert.equal(gate.accept(roundtrip(recent), 0, canonicalJson(DEFAULT_POLICY)), true);
  assert.equal(gate.accept(recent, 0, canonicalJson(DEFAULT_POLICY)), false);
  const edited = gate.issue(1, 'policy-a');
  assert.equal(gate.accept(edited, 2, 'policy-a'), false);
  const changedPolicy = gate.issue(2, 'policy-a');
  assert.equal(gate.accept(changedPolicy, 2, 'policy-b'), false);
  const cancelled = gate.issue(3, 'policy-a');
  gate.invalidate();
  assert.equal(gate.accept(cancelled, 3, 'policy-a'), false);
});

test('corrupt serialized history is rejected before it can overflow on Undo', () => {
  const snapshot = roundtrip(createSession({b:makeDocument('current')}));
  snapshot.past = Array.from({length:26}, () => makeDocument('past'));
  snapshot.future = Array.from({length:25}, () => makeDocument('future'));
  const before = canonicalJson(snapshot);
  assert.throws(() => move(snapshot, 'undo', 'corrupt-undo'), /history/i);
  assert.equal(canonicalJson(snapshot), before);
});

test('canonical JSON is key-order independent and rejects lossy or side-effectful values', () => {
  assert.equal(canonicalJson({b:[1,true,null], a:'🦀'}), canonicalJson({a:'🦀', b:[1,true,null]}));
  assert.equal(canonicalJson(JSON.parse('{"__proto__":{"a":1},"z":2}')), '{"__proto__":{"a":1},"z":2}');
  const cycle = {}; cycle.self = cycle;
  const getter = Object.defineProperty({}, 'a', {enumerable:true, get() { throw new Error('getter evaluated'); }});
  for (const value of [undefined, NaN, Infinity, {a:undefined}, new Date(), [,,], cycle, getter, {[Symbol('s')]:1}]) {
    assert.throws(() => canonicalJson(value), /./);
  }
});
