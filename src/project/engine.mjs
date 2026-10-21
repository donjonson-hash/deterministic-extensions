// Node adapter: explicit local filesystem and Git effects, never part of the pure core.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../core/canonical.mjs';

export const PROJECT_POLICY = 'project-branch-v1';
export const PROJECT_LIMITS = Object.freeze({
  files: 1000, bytes: 20 * 1024 * 1024, changes: 1000,
  checks: 8, checkTimeoutMs: 30_000, checkOutputBytes: 64 * 1024,
});
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function fail(message) { throw new Error(message); }
function strictText(bytes, label) {
  try {
    const value = textDecoder.decode(bytes);
    if (value.includes('\0')) fail('NUL');
    return value;
  } catch { fail(`${label}: only valid UTF-8 text without NUL is editable`); }
}
function validPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || !value.isWellFormed() ||
      /[\\\x00-\x1f\x7f:*?"<>|]/u.test(value) || value.startsWith('/')) {
    fail('Invalid project-relative path');
  }
  for (const part of value.split('/')) {
    if (!part || part === '.' || part === '..' || part.toLowerCase() === '.git' ||
        /[. ]$/u.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) {
      fail(`Unsafe or unsupported path: ${value}`);
    }
  }
  return value;
}
function validatePaths(files) {
  const names = [...files.keys()].sort(lexical);
  const seen = new Map();
  for (const name of names) {
    validPath(name);
    const lower = name.toLowerCase();
    if (seen.has(lower)) fail(`Case-colliding paths: ${seen.get(lower)} and ${name}`);
    seen.set(lower, name);
  }
  // Also reject file/directory and differently-cased directory collisions.
  const directories = new Map();
  for (const name of names) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const lower = prefix.toLowerCase();
      if (seen.has(lower)) fail(`File/directory collision: ${prefix}`);
      if (directories.has(lower) && directories.get(lower) !== prefix) fail(`Case-colliding directory: ${prefix}`);
      directories.set(lower, prefix);
    }
  }
}
function validateBounds(files) {
  if (files.size > PROJECT_LIMITS.files) fail(`Project exceeds ${PROJECT_LIMITS.files} files`);
  let size = 0;
  for (const item of files.values()) size += item.bytes.length;
  if (size > PROJECT_LIMITS.bytes) fail(`Project exceeds ${PROJECT_LIMITS.bytes} bytes`);
  validatePaths(files);
}
function snapshotDigest(files) {
  return hash(canonicalJson([...files].sort(([a], [b]) => lexical(a, b)).map(([name, item]) =>
    ({ path: name, mode: item.mode, digest: hash(item.bytes) }))));
}

// Commands use argv, not a shell. Output is drained after the cap to avoid a deadlock.
function command(argv, { cwd, env = process.env, input, timeoutMs = 30_000,
  maxBytes = PROJECT_LIMITS.bytes + 1024 * 1024, truncate = false } = {}) {
  return new Promise(resolve => {
    const chunks = [], errors = [];
    let total = 0, overflow = false, timedOut = false, spawnError = null;
    let child;
    const stop = () => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already exited */ }
    };
    const collect = target => data => {
      const remaining = Math.max(0, maxBytes - total);
      total += data.length;
      if (remaining) target.push(data.subarray(0, remaining));
      if (total > maxBytes) { overflow = true; if (!truncate) stop(); }
    };
    try { child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false,
      detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: error.message }); return; }
    child.stdout.on('data', collect(chunks));
    child.stderr.on('data', collect(errors));
    child.on('error', error => { spawnError = error.message; });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errors),
        timedOut, overflow, error: spawnError });
    });
  });
}
function gitEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0', ...extra };
}
async function git(cwd, args, { input, env, allowFailure = false } = {}) {
  const result = await command(['git', '-c', `core.hooksPath=${os.devNull}`, '-c', 'core.fsmonitor=false',
    '-c', 'commit.gpgSign=false', ...args], { cwd, env: gitEnv(env), input });
  if (result.error || result.timedOut || result.overflow || (!allowFailure && result.code !== 0)) {
    fail(`Git ${args[0]} failed: ${result.error || (result.timedOut ? 'timeout' : result.overflow ? 'output limit' : result.stderr.toString('utf8').trim())}`);
  }
  return result;
}
async function gitText(cwd, args, options) { return (await git(cwd, args, options)).stdout.toString('utf8').trim(); }
async function fileAt(root, relative, { missing = false } = {}) {
  const parts = relative.split('/');
  let location = root;
  for (let i = 0; i < parts.length; i++) {
    location = path.join(location, parts[i]);
    let stat;
    try { stat = await fs.lstat(location); } catch (error) {
      if (missing && error.code === 'ENOENT') return null;
      fail(`Missing or unreadable project path: ${relative}`);
    }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      fail(`Only regular files and directories are supported: ${relative}`);
    }
    if (i === parts.length - 1) return { location, stat };
  }
}
async function sameFile(root, relative, expected) {
  const entry = await fileAt(root, relative);
  if (entry.stat.size !== expected.bytes.length ||
      (process.platform !== 'win32' && Boolean(entry.stat.mode & 0o111) !== (expected.mode === '100755'))) return false;
  return (await fs.readFile(entry.location)).equals(expected.bytes);
}
// Git's -z output legitimately contains NUL delimiters (unlike editable documents).
function gitRecords(buffer) {
  let value;
  try { value = textDecoder.decode(buffer); } catch { fail('Git paths must be valid UTF-8'); }
  return value.split('\0').filter(Boolean);
}

export async function createProjectSession({ projectPath, checks = [] } = {}) {
  if (typeof projectPath !== 'string' || !projectPath) fail('projectPath is required');
  const configuredChecks = JSON.parse(canonicalJson(checks));
  if (!Array.isArray(configuredChecks) || configuredChecks.length > PROJECT_LIMITS.checks) fail('Invalid checks');
  for (const item of configuredChecks) {
    if (!item || Object.keys(item).sort().join(',') !== 'argv,name' ||
        typeof item.name !== 'string' || !item.name || item.name.length > 128 ||
        !Array.isArray(item.argv) || !item.argv.length || item.argv.length > 128 ||
        item.argv.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0')) || !item.argv[0]) fail('Invalid check definition');
  }
  if (new Set(configuredChecks.map(item => item.name)).size !== configuredChecks.length) fail('Check names must be unique');
  const root = await fs.realpath(projectPath);
  const top = await gitText(root, ['rev-parse', '--show-toplevel']);
  if (await fs.realpath(top) !== root) fail('Select the Git repository root, not a subdirectory');
  const baseCommit = await gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const baseTree = await gitText(root, ['rev-parse', `${baseCommit}^{tree}`]);
  const originalHeadRef = await gitText(root, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true });
  const commitTime = await gitText(root, ['show', '-s', '--format=%ct', baseCommit]);
  if (!/^\d+$/u.test(commitTime)) fail('Unsupported base commit timestamp');
  const entries = gitRecords((await git(root, ['ls-tree', '-r', '-z', baseCommit])).stdout);
  if (entries.length > PROJECT_LIMITS.files) fail(`Project exceeds ${PROJECT_LIMITS.files} files`);
  const base = new Map();
  let totalBytes = 0;
  for (const entry of entries) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/u.exec(entry);
    if (!match || match[2] !== 'blob' || !['100644', '100755'].includes(match[1])) fail('Symlinks, submodules and special files are unsupported');
    const [, mode, , oid, name] = match;
    validPath(name);
    const size = Number(await gitText(root, ['cat-file', '-s', oid]));
    if (!Number.isSafeInteger(size) || size < 0 || totalBytes + size > PROJECT_LIMITS.bytes) fail(`Project exceeds ${PROJECT_LIMITS.bytes} bytes`);
    const bytes = (await git(root, ['cat-file', 'blob', oid])).stdout;
    totalBytes += bytes.length;
    base.set(name, { mode, oid, bytes });
  }
  validateBounds(base);
  const baseSnapshot = snapshotDigest(base);
  async function verifySource() {
    if (await gitText(root, ['rev-parse', '--verify', 'HEAD^{commit}']) !== baseCommit ||
        await gitText(root, ['symbolic-ref', '-q', 'HEAD'], { allowFailure: true }) !== originalHeadRef ||
        await gitText(root, ['rev-parse', 'HEAD^{tree}']) !== baseTree) fail('Source HEAD changed; open a new session');
    const indexEntries = gitRecords((await git(root, ['ls-files', '--stage', '-z'])).stdout);
    if (indexEntries.length !== base.size) fail('Source index is dirty or has conflicts');
    for (const entry of indexEntries) {
      const match = /^(\d+) ([a-f0-9]+) (\d+)\t([\s\S]+)$/u.exec(entry);
      const expected = match && base.get(match[4]);
      if (!expected || match[3] !== '0' || match[1] !== expected.mode || match[2] !== expected.oid) fail('Source index is dirty or has conflicts');
    }
    if ((await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.length) fail('Source has untracked files; commit, move or ignore them first');
    for (const [name, item] of base) {
      if (!await sameFile(root, name, item)) fail(`Source file changed or checkout bytes differ from Git: ${name}`);
    }
  }
  await verifySource();
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'det-project-'));
  let state = 'ready', proposal = null, candidate = null, candidatePath = null, branch = null, commit = null;
  let closed = false;
  let checkResults = configuredChecks.map(({ name }) => ({ name, status: 'not-run', output: '' }));
  const consumedIds = new Set();
  function status() {
    return structuredClone({ projectPath: root, baseCommit, baseTree, snapshotDigest: baseSnapshot,
      policy: PROJECT_POLICY, limits: PROJECT_LIMITS, state, proposal, checks: checkResults, branch, commit, candidatePath });
  }
  async function verifyCandidate() {
    if (!candidatePath || !candidate) fail('Prepare a proposal first');
    const candidateStat = await fs.lstat(candidatePath);
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) fail('Candidate directory was replaced');
    for (const [name, item] of candidate) {
      if (!await sameFile(candidatePath, name, item)) fail(`Candidate changed after preview: ${name}; prepare a new proposal`);
    }
    for (const name of base.keys()) {
      if (!candidate.has(name) && await fileAt(candidatePath, name, { missing: true })) fail(`Deleted file reappeared in candidate: ${name}`);
    }
    // A check must validate exactly the files that will be published. Even an
    // untracked generated helper could otherwise make the check pass falsely.
    async function scan(relative = '') {
      const directory = path.join(candidatePath, relative);
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (![...candidate.keys()].some(file => file.startsWith(`${name}/`))) fail(`Unexpected candidate directory: ${name}`);
          await scan(name);
        } else if (!entry.isFile() || !candidate.has(name)) {
          fail(`Unexpected candidate file: ${name}; checks cannot generate files`);
        }
      }
    }
    await scan();
  }
  async function prepare(input) {
    if (!['ready', 'prepared'].includes(state)) fail('Open a new session for another proposal after publication');
    const value = JSON.parse(canonicalJson(input));
    if (!value || Object.keys(value).sort().join(',') !== 'baseCommit,changes,id,schemaVersion,title' ||
        value.schemaVersion !== 1 || typeof value.id !== 'string' || !value.id || value.id.length > 128 ||
        typeof value.title !== 'string' || !value.title || value.title.length > 200 ||
        /[\x00-\x1f\x7f]/u.test(value.title) || !value.title.isWellFormed() ||
        !Array.isArray(value.changes) || !value.changes.length || value.changes.length > PROJECT_LIMITS.changes) fail('Invalid proposal schema');
    if (value.baseCommit !== baseCommit) fail('Stale baseCommit; open a new session');
    if (consumedIds.has(value.id)) fail('Proposal ID already used in this session');
    await verifySource();
    const next = new Map(base), preview = [], seen = new Set();
    for (const change of value.changes) {
      if (!change || !['write', 'delete'].includes(change.operation) ||
          Object.keys(change).sort().join(',') !== (change.operation === 'write' ? 'operation,path,text' : 'operation,path')) fail('Invalid change schema');
      const name = validPath(change.path);
      if (seen.has(name)) fail(`Duplicate change path: ${name}`);
      seen.add(name);
      const previous = base.get(name);
      const before = previous ? strictText(previous.bytes, name) : null;
      if (change.operation === 'delete') {
        if (!previous) fail(`Cannot delete missing file: ${name}`);
        next.delete(name);
        preview.push({ path: name, kind: 'deleted', before, after: null });
      } else {
        if (typeof change.text !== 'string' || !change.text.isWellFormed() || change.text.includes('\0')) fail(`Invalid UTF-8 text: ${name}`);
        const bytes = Buffer.from(change.text, 'utf8');
        if (previous?.bytes.equals(bytes)) fail(`Change has no effect: ${name}`);
        next.set(name, { mode: previous?.mode ?? '100644', bytes });
        preview.push({ path: name, kind: previous ? 'modified' : 'added', before, after: change.text });
      }
    }
    validateBounds(next);
    // File-to-directory transitions are intentionally outside this pilot contract.
    validatePaths(new Map([...base, ...next]));
    preview.sort((a, b) => lexical(a.path, b.path));
    const prepared = { id: value.id, title: value.title,
      digest: hash(canonicalJson({ policy: PROJECT_POLICY, baseCommit, baseTree,
        snapshotDigest: baseSnapshot, id: value.id, title: value.title, changes: preview })), changes: preview };
    const nextPath = await fs.mkdtemp(path.join(temp, 'candidate-'));
    try {
      for (const [name, item] of next) {
        const target = path.join(nextPath, name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, item.bytes, { flag: 'wx', mode: item.mode === '100755' ? 0o755 : 0o644 });
      }
    } catch (error) { await fs.rm(nextPath, { recursive: true, force: true }); throw error; }
    const previousPath = candidatePath;
    candidatePath = nextPath; candidate = next; proposal = prepared; state = 'prepared';
    consumedIds.add(value.id);
    checkResults = configuredChecks.map(({ name }) => ({ name, status: 'not-run', output: '' }));
    if (previousPath) await fs.rm(previousPath, { recursive: true, force: true });
    return status();
  }
  async function runChecks() {
    if (state !== 'prepared') fail('Checks require a prepared proposal');
    await verifySource();
    await verifyCandidate();
    checkResults = configuredChecks.map(({ name }) => ({ name, status: 'not-run', output: '' }));
    for (let index = 0; index < configuredChecks.length; index++) {
      const check = configuredChecks[index];
      const result = await command(check.argv, { cwd: candidatePath, timeoutMs: PROJECT_LIMITS.checkTimeoutMs,
        maxBytes: PROJECT_LIMITS.checkOutputBytes, truncate: true });
      const output = result.stdout.toString('utf8') + result.stderr.toString('utf8') +
        (result.error ? `\n${result.error}` : '') + (result.overflow ? '\n[output truncated]' : '');
      checkResults[index] = { name: check.name, status: result.error ? 'error' : result.timedOut ? 'timeout' : result.code === 0 ? 'passed' : 'failed', output };
      try { await verifyCandidate(); } catch (error) {
        checkResults[index].status = 'error';
        checkResults[index].output += `\n${error.message}`;
        break;
      }
      if (checkResults[index].status !== 'passed') break;
    }
    return status();
  }
  async function assertNotCheckedOut(ref) {
    const output = gitRecords((await git(root, ['worktree', 'list', '--porcelain', '-z'])).stdout);
    if (output.includes(`branch ${ref}`)) fail('Published branch is checked out in a worktree; switch that worktree before Undo/Redo');
  }
  async function publish() {
    if (state === 'published') return status(); // Retry is idempotent; never creates another commit.
    if (state !== 'prepared') fail('Publish requires a prepared proposal; use Redo for an undone branch');
    if (checkResults.some(item => item.status !== 'passed')) fail('Every configured check must pass before publication');
    await verifySource();
    await verifyCandidate();
    const nextBranch = `deterministic/${proposal.digest.slice(0, 24)}`;
    const ref = `refs/heads/${nextBranch}`;
    if ((await git(root, ['show-ref', '--verify', '--quiet', ref], { allowFailure: true })).code === 0) fail('Publication branch already exists; refusing to overwrite it');
    const env = { GIT_INDEX_FILE: path.join(temp, 'publish-index') };
    await git(root, ['read-tree', baseCommit], { env });
    const updates = [];
    for (const change of proposal.changes) {
      const item = candidate.get(change.path);
      const oid = item ? await gitText(root, ['hash-object', '-w', '--stdin'], { input: item.bytes }) : '0'.repeat(baseCommit.length);
      updates.push(`${item?.mode ?? '0'} ${oid}\t${change.path}\0`);
    }
    await git(root, ['update-index', '-z', '--index-info'], { env, input: updates.join('') });
    const tree = await gitText(root, ['write-tree'], { env });
    const identity = { GIT_AUTHOR_NAME: 'Deterministic Project Pilot', GIT_AUTHOR_EMAIL: 'project-pilot@localhost',
      GIT_COMMITTER_NAME: 'Deterministic Project Pilot', GIT_COMMITTER_EMAIL: 'project-pilot@localhost',
      GIT_AUTHOR_DATE: `@${commitTime} +0000`, GIT_COMMITTER_DATE: `@${commitTime} +0000` };
    const nextCommit = await gitText(root, ['commit-tree', tree, '-p', baseCommit], { env: identity,
      input: `${proposal.title}\n\nPolicy: ${PROJECT_POLICY}\nProposal-SHA256: ${proposal.digest}\n` });
    // Recheck after object construction. Only the ref transition below is atomic.
    await verifySource();
    await verifyCandidate();
    await assertNotCheckedOut(ref);
    await git(root, ['update-ref', ref, nextCommit, '0'.repeat(baseCommit.length)]);
    branch = nextBranch; commit = nextCommit; state = 'published';
    return status();
  }
  async function undo() {
    if (state !== 'published') fail('Undo requires a published branch');
    const ref = `refs/heads/${branch}`;
    await assertNotCheckedOut(ref);
    await git(root, ['update-ref', '-d', ref, commit]);
    state = 'undone';
    return status();
  }
  async function redo() {
    if (state !== 'undone') fail('Redo requires an undone branch');
    await verifySource();
    const ref = `refs/heads/${branch}`;
    await assertNotCheckedOut(ref);
    await git(root, ['update-ref', ref, commit, '0'.repeat(baseCommit.length)]);
    state = 'published';
    return status();
  }
  let queue = Promise.resolve();
  function enqueue(operation) {
    const work = queue.then(() => {
      if (closed) fail('Project session is closed');
      return operation();
    });
    queue = work.catch(() => {});
    return work;
  }
  return Object.freeze({
    status: () => enqueue(status), prepare: input => enqueue(() => prepare(input)),
    runChecks: () => enqueue(runChecks), publish: () => enqueue(publish),
    undo: () => enqueue(undo), redo: () => enqueue(redo),
    close: () => enqueue(async () => { await fs.rm(temp, { recursive: true, force: true }); closed = true; }),
  });
}
