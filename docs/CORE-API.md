# Core API v0.1

The modules under `src/core/` are dependency-free browser ES modules. Their
inputs are explicit; they read no clock, locale, network, storage or random
source. Invalid session state throws; invalid commands return a rejection.
Nothing here executes uploaded code or proves the semantic correctness of text.

## Shared UTF-8 codec

`utf8.mjs` is the policy-free conversion layer, identified by
`UTF8_CODEC_VERSION = 'utf8-v1'`. It can be copied unchanged into a product
adapter with source revision and checksum recorded by that product.

- `decodeUtf8Bytes(bytes)` accepts only `Uint8Array`, including an offset view,
  and returns `{raw, bom}`. Invalid UTF-8 throws `TypeError`; no replacement
  decoding is performed. Exactly one initial UTF-8 BOM is separated from text.
- `encodeUtf8Text(raw, bom = false)` requires a string and a boolean and returns
  fresh UTF-8 bytes. It follows standard `TextEncoder` behavior, including
  replacing unpaired UTF-16 surrogates with U+FFFD. It does not enforce a
  lossless document policy for arbitrary JavaScript strings.

The codec imposes no size, line, NUL or well-formed-string policy and performs
no line-ending normalization. Callers must apply their product's limits before
decoding or storing data. `documents.mjs` remains the strict adapter: it rejects
unpaired surrogates and preserves all existing limits, error codes and document
semantics. A different product can keep its existing validation and messages
while using the same byte conversion code.

## Documents

`makeDocument(raw = '', bom = false)` returns a detached frozen `{raw, bom}`.
`raw` preserves CRLF, CR, LF, mixed line endings and final newline exactly. A
leading UTF-8 file marker is represented by `bom`; a subsequent U+FEFF remains
part of raw text. `decodeUtf8(Uint8Array)` rejects invalid UTF-8 rather than
silently replacing characters. `encodeUtf8(document)` returns new bytes.

`normalizedText(document)` maps CRLF and CR to LF for comparison only. It does
not modify the raw document. Unpaired UTF-16 surrogates are rejected because
encoding them would replace text. The fixed limits in `DOCUMENT_LIMITS` are
1 MiB UTF-8, 200,000 UTF-16 code units and 4,000 lines (an empty document has
one line). Unsupported formats and encoding detection belong to adapters.

## Comparison

`compareDocuments(a, b, policy = DEFAULT_POLICY)` always recomputes a report
from the complete current documents. The only supported policy is:

```js
{id: 'line-index-v1', ignoreTrailingWhitespace: false}
```

Trailing-whitespace ignoring accepts only ASCII space and tab. Policy changes
are inputs, not hidden preferences. A policy id or shape that is not supported
throws. Canonical policy serialization can be used as a worker context key.

The report contains `policy`, `alignment: 'line-index'`, `minimal: false`,
`equalText`, `equalBytes`, `formatOnly`, `rows` and `changes`. A row is
`{line, a, b, kind}`: one-based line index, string or null for either side,
and kind `equal`, `changed`, `added` or `removed`. `changes` excludes equal
rows. `equalText` follows the selected whitespace policy; `formatOnly` means
strictly LF-normalized text is identical while raw/BOM data differs.

This demonstrator aligns by line number. An inserted first line can make many
later rows differ. It is intentionally **not a minimal diff**, a replacement
for CodeMirror, or an extraction of the production comparison engine. The
transfer example copies all of A, including its BOM and original line endings.
Production block transfers require their own versioned range/provenance rules.

## Session and commands

`createSession({a, b})` accepts optional documents, defaulting to empty ones.
State is frozen JSON with schemaVersion 1, `a`, `b`, global `revision`,
`aRevision`, `bRevision`, B-only `past`/`future` history and `consumedIds`.
Accepted content changes (including Undo/Redo) increase the global revision
and the affected document revision. Identity and revision are not timestamps.

```js
const command = {
  id: 'editor-b-1', type: 'replace-b', expectedRevision: state.revision,
  document: makeDocument('new text\r\n', true)
};
const result = reduceSession(state, command);
state = result.state;
```

Supported commands:

| Type | Fields in addition to id, type, expectedRevision | Effect |
| --- | --- | --- |
| replace-a | document | Replace A, leave B history alone |
| replace-b | document | Replace B, append prior B to history, clear redo |
| use-a | Use `prepareUseA(state, id)` | Copy captured raw A into captured B |
| undo | none | Restore previous B; A is unchanged |
| redo | none | Restore next B; A is unchanged |

`prepareUseA` includes schemaVersion 1, both revisions and detached raw source
and target snapshots. The UI must capture this proposal when displaying its
action; it must not silently regenerate a stale proposal at click time.

`reduceSession(state, command)` returns `{state, status}`. `applied` is the only
status with new state. `stale`, `invalid`, `already-applied`, `no-change` and
`limit-exceeded` return the exact input state. Rejected and no-op commands do
not consume identity or modify history. Applied identities remain consumed
after Undo; replay cannot reapply an old click. A fresh deliberate action needs
a new id. Unknown/extra command fields are rejected. All input documents and
successful result states are detached, so later caller mutation cannot change
the transaction. Serializing and parsing a proposal does not alter its meaning.

History is capped at 50 B snapshots. At 2,048 accepted commands the session
rejects further changes rather than forgetting replay protection. Command ids
must be nonempty strings up to 128 code units. A new session is explicit and
resets both replay history and revisions; never reuse old proposals across it.
The demo starts fresh on reload and does not promise persisted idempotency.

## Asynchronous result gate

`createResultGate()` returns a stateful in-memory adapter, with deterministic
sequence numbers. Use a separate gate per independent operation stream:

```js
const ticket = gate.issue(state.revision, canonicalJson(policy));
// Send {ticket, a: state.a, b: state.b, policy} to a worker.
// On a response, compare against CURRENT revision and policy:
if (gate.accept(response.ticket, state.revision, canonicalJson(policy))) {
  render(response.report);
}
```

Only the most recently issued ticket matching current revision/context is
accepted, once. `invalidate()` cancels eligibility without modifying documents;
it does not abort work in progress. Include every relevant setting (language,
parser version, comparison policy) in contextKey. Gate acceptance does not make
an external UI effect atomic, authenticate a worker or replace input validation.
Create a new gate with each session; do not attach old worker responses to it.

## Canonical serialization

`canonicalJson(value)` sorts object keys in UTF-16 order and preserves array
order. It accepts null, booleans, strings, finite numbers, dense arrays and
plain objects. Undefined, NaN/infinities, cycles, classes, accessors, symbol
keys, hidden object properties and sparse/extended arrays throw. It does not
call getters or `toJSON`. JSON canonicalization maps -0 to 0 and is not a hash,
signature, RFC 8785 implementation or byte serializer for arbitrary objects.
`freezeJson` is the internal deep-freeze utility for already validated JSON.
