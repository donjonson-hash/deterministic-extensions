import {decodeUtf8, encodeUtf8, makeDocument, normalizedText} from './core/documents.mjs';
import {DEFAULT_POLICY} from './core/comparison.mjs';
import {createSession, reduceSession, prepareUseA} from './core/session.mjs';
import {canonicalJson} from './core/canonical.mjs';
import {createResultGate} from './core/gates.mjs';

const $ = id => document.getElementById(id);
let state = createSession({});
let commandSequence = 0;
let policy = {...DEFAULT_POLICY};
const nextId = () => `ui-${++commandSequence}`;
const names = {a: 'No file selected', b: 'No file selected'};
const loadGates = {a: createResultGate(), b: createResultGate()};
const loadRequests = {a: 0, b: 0};
const compareGate = createResultGate();
const worker = new Worker(new URL('./worker.mjs', import.meta.url), {type: 'module'});
let workerFailed = false;

function invalidateLoad(side) {
  loadRequests[side] += 1;
  loadGates[side].invalidate();
}

function notify(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}

function eolLabel(doc) {
  const endings = new Set(doc.raw.match(/\r\n|\r|\n/g) || []);
  if (endings.size > 1) return 'mixed line endings';
  return ({'\r\n':'CRLF', '\n':'LF', '\r':'CR'})[[...endings][0]] || 'no line breaks';
}

function requestComparison() {
  if (workerFailed) return;
  const ticket = compareGate.issue(state.revision, canonicalJson(policy));
  $('worker-status').dataset.state = 'pending';
  $('worker-status').textContent = 'Comparing the current files locally…';
  $('comparison-title').textContent = 'Comparing…';
  $('change-list').replaceChildren();
  $('format-note').hidden = true;
  worker.postMessage({ticket, a: state.a, b: state.b, policy});
}

function render() {
  for (const side of ['a', 'b']) {
    const doc = state[side], text = normalizedText(doc);
    if ($(`text-${side}`).value !== text) $(`text-${side}`).value = text;
    $(`name-${side}`).textContent = names[side];
    $(`meta-${side}`).textContent = `${text.length} characters · ${encodeUtf8(doc).length} bytes · ${eolLabel(doc)}${doc.bom ? ' · BOM' : ''}`;
  }
  document.body.dataset.revision = String(state.revision);
  $('revision').textContent = `Revision ${state.revision}`;
  $('undo').disabled = state.past.length === 0;
  $('redo').disabled = state.future.length === 0;

  // Each displayed control owns its immutable proposal. Even a detached old
  // control can only replay that proposal, never target the latest document.
  const priorButton = $('use-a');
  const button = priorButton.cloneNode(true);
  const proposal = prepareUseA(state, nextId());
  button.disabled = state.a.raw === state.b.raw && state.a.bom === state.b.bom;
  button.addEventListener('click', event => {
    if (event.detail > 1) return;
    if (dispatch(proposal, 'A copied to B. Undo restores the previous B bytes.')) invalidateLoad('b');
  });
  priorButton.replaceWith(button);
  requestComparison();
}

function dispatch(command, successMessage) {
  const result = reduceSession(state, command);
  if (result.status === 'applied') {
    state = result.state;
    render();
    if (successMessage) notify(successMessage);
    return true;
  }
  const reasons = {
    'no-change':'There is no change to apply.',
    'already-applied':'This command was already applied. Its replay was ignored.',
    stale:'The files changed after this action was prepared. Review the current result and try again.',
    invalid:'The action is invalid and was not applied.',
    'limit-exceeded':'The document or history limit was reached. The action was not applied.'
  };
  notify(reasons[result.status] || `Action rejected: ${result.status}`, !['no-change', 'already-applied'].includes(result.status));
  return false;
}

async function loadFile(side, file) {
  if (!file) return;
  const requestId = ++loadRequests[side];
  const ticket = loadGates[side].issue(state[`${side}Revision`], side);
  if (file.size > 1_048_576) { notify('This reference template accepts files up to 1 MiB. The core also checks text and history limits.', true); return; }
  notify(`Opening ${side.toUpperCase()}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!loadGates[side].accept(ticket, state[`${side}Revision`], side)) return;
    const doc = decodeUtf8(bytes);
    const previousName = names[side];
    names[side] = `Last opened: ${file.name}`;
    if (!dispatch({id:nextId(), type:`replace-${side}`, expectedRevision:state.revision, document:doc}, `${side.toUpperCase()} opened. Original UTF-8 bytes are retained.`)) names[side] = previousName;
  } catch (error) {
    // Do not let a superseded file request overwrite the current message.
    if (loadRequests[side] === requestId && state[`${side}Revision`] === ticket.revision) notify(error.message || 'The file could not be opened.', true);
  }
}

for (const side of ['a', 'b']) {
  $(`file-${side}`).addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    void loadFile(side, file);
  });
}

$('text-b').addEventListener('input', () => {
  invalidateLoad('b');
  try {
    const document = makeDocument($('text-b').value, state.b.bom);
    if (!dispatch({id:nextId(), type:'replace-b', expectedRevision:state.revision, document}, 'B edited. Manual text edits use LF line endings.')) $('text-b').value = normalizedText(state.b);
  } catch (error) {
    $('text-b').value = normalizedText(state.b);
    notify(error.message || 'This edit could not be applied.', true);
  }
});

for (const type of ['undo', 'redo']) $(type).addEventListener('click', () => {
  invalidateLoad('b');
  dispatch({id:nextId(), type, expectedRevision:state.revision}, `${type === 'undo' ? 'Undo' : 'Redo'} restored B's exact bytes.`);
});

$('example').addEventListener('click', () => {
  invalidateLoad('a'); invalidateLoad('b');
  names.a = 'Example: reference.js'; names.b = 'Example: revised.js';
  dispatch({id:nextId(), type:'replace-a', expectedRevision:state.revision, document:makeDocument('const price = 12;\r\nconst count = 3;\r\nconst total = price * count;\r\nconsole.log(total);\r\n', true)});
  dispatch({id:nextId(), type:'replace-b', expectedRevision:state.revision, document:makeDocument('const price = 12;\nconst count = 3;\nconst total = price + count;\nconsole.log(total);\n')}, 'Example loaded. Review the changed line, then use A, Undo, Redo and Download B.');
});

$('ignore-trailing').addEventListener('change', () => {
  policy = {...DEFAULT_POLICY, ignoreTrailingWhitespace:$('ignore-trailing').checked};
  requestComparison();
});

$('download-b').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([encodeUtf8(state.b)], {type:'text/plain;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url; link.download = 'reviewed-b.txt';
  document.body.append(link); link.click(); link.remove();
  // Timing belongs to the shell cleanup, never to comparison or saved bytes.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  notify('B downloaded as reviewed-b.txt. The source file was not overwritten.');
});

function jumpToLine(line) {
  for (const side of ['a', 'b']) {
    const field = $(`text-${side}`), lines = field.value.split('\n');
    const index = Math.min(Math.max(line - 1, 0), lines.length - 1);
    const start = lines.slice(0, index).reduce((count, text) => count + text.length + 1, 0);
    field.setSelectionRange(start, start + lines[index].length);
    field.scrollTop = Math.max(0, index * parseFloat(getComputedStyle(field).lineHeight) - field.clientHeight / 3);
  }
  $('text-b').focus({preventScroll:true});
}

function showReport(report) {
  $('comparison-title').textContent = report.changes.length ? `${report.changes.length} different line positions` : 'Text matches under the selected policy';
  $('format-note').hidden = report.equalBytes || report.changes.length > 0;
  $('format-note').textContent = report.equalBytes ? '' : 'The comparison matches, but the original bytes differ. Line endings, BOM or ignored trailing spaces can still be different.';
  $('change-list').replaceChildren();
  if (!report.changes.length) {
    const empty = document.createElement('p'); empty.className = 'empty-state';
    empty.textContent = report.equalBytes ? 'A and B contain identical UTF-8 bytes.' : 'Use Download B to retain B’s original bytes, or Use all of A to copy A exactly.';
    $('change-list').append(empty);
  }
  for (const row of report.changes.slice(0, 100)) {
    const card = document.createElement('article'); card.className = 'change-row';
    const header = document.createElement('header');
    const title = document.createElement('span'); title.textContent = `Line ${row.line} · ${row.kind}`;
    const jump = document.createElement('button'); jump.type = 'button'; jump.textContent = 'Show line'; jump.addEventListener('click', () => jumpToLine(row.line));
    header.append(title, jump);
    const pair = document.createElement('div'); pair.className = 'row-pair';
    for (const side of ['a', 'b']) {
      const text = document.createElement('pre'); text.textContent = row[side] === null ? '(no line)' : row[side] || '(empty line)';
      text.setAttribute('aria-label', `Version ${side.toUpperCase()}, line ${row.line}`); pair.append(text);
    }
    card.append(header, pair); $('change-list').append(card);
  }
  if (report.changes.length > 100) {
    const more = document.createElement('p'); more.className = 'note';
    more.textContent = `Showing the first 100 of ${report.changes.length} different line positions. Both complete texts remain in the editors.`;
    $('change-list').append(more);
  }
  $('worker-status').dataset.state = 'ready';
  $('worker-status').dataset.revision = String(state.revision);
  $('worker-status').textContent = `Local worker · ${report.policy.id} · repeatable indexed-line comparison, not a minimal diff.`;
}

worker.onmessage = event => {
  const {ticket, report, error} = event.data;
  if (!compareGate.accept(ticket, state.revision, canonicalJson(policy))) return;
  if (error) {
    $('comparison-title').textContent = 'Comparison unavailable';
    $('worker-status').dataset.state = 'error';
    $('worker-status').textContent = error;
    return;
  }
  showReport(report);
};
worker.onerror = () => {
  workerFailed = true; compareGate.invalidate();
  $('comparison-title').textContent = 'Comparison unavailable';
  $('worker-status').dataset.state = 'error';
  $('worker-status').textContent = 'The local worker could not run. Reload this page after downloading B.';
};

render();
