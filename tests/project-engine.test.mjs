import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectSession, PROJECT_LIMITS } from '../src/project/engine.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=Pilot Test', '-c', 'user.email=pilot@test.local',
    '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${os.devNull}`, ...args],
  { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull } }).trim();
}
async function fixture(t, files = { 'src/main.js': 'export const answer = 1;\r\n', 'README.md': '\uFEFFOriginal\n',
  'delete.txt': 'delete me\n', 'binary.bin': Buffer.from([0, 0xff, 0xfe, 13, 10]) }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-engine-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  for (const [name, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), bytes);
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Base');
  const baseCommit = git(root, 'rev-parse', 'HEAD');
  const sessions = [];
  t.after(async () => { for (const session of sessions) await session.close().catch(() => {}); });
  return { root, baseCommit, async session(checks = []) {
    const session = await createProjectSession({ projectPath: root, checks });
    sessions.push(session); return session;
  }, proposal(changes, id = 'review-1') {
    return { schemaVersion: 1, id, title: 'Reviewed project changes', baseCommit,
      changes: changes ?? [
        { path: 'src/main.js', operation: 'write', text: 'export const answer = 42;\r\n' },
        { path: 'new/file.txt', operation: 'write', text: '\uFEFFNew\r\n' },
        { path: 'delete.txt', operation: 'delete' },
      ] };
  } };
}

test('publishes a complete reviewed tree on one local branch; original files and index stay unchanged', async t => {
  const f = await fixture(t);
  const originalIndex = await fs.readFile(path.join(f.root, '.git/index'));
  const session = await f.session();
  const prepared = await session.prepare(f.proposal());
  assert.equal(prepared.state, 'prepared');
  assert.deepEqual(prepared.proposal.changes.map(item => [item.path, item.kind]),
    [['delete.txt', 'deleted'], ['new/file.txt', 'added'], ['src/main.js', 'modified']]);
  assert.equal(prepared.proposal.changes[2].before, 'export const answer = 1;\r\n');
  assert.equal(await fs.readFile(path.join(prepared.candidatePath, 'README.md'), 'utf8'), '\uFEFFOriginal\n');
  const published = await session.publish();
  assert.equal(published.state, 'published');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.baseCommit);
  assert.equal(git(f.root, 'rev-parse', `${published.commit}^`), f.baseCommit);
  assert.equal(git(f.root, 'rev-list', '--count', `${f.baseCommit}..${published.branch}`), '1');
  assert.equal(git(f.root, 'show', `${published.branch}:src/main.js`), 'export const answer = 42;');
  assert.equal(git(f.root, 'show', `${published.branch}:new/file.txt`), 'New');
  assert.equal(git(f.root, 'ls-tree', published.branch, 'delete.txt'), '');
  assert.equal(await fs.readFile(path.join(f.root, 'src/main.js'), 'utf8'), 'export const answer = 1;\r\n');
  assert.deepEqual(await fs.readFile(path.join(f.root, '.git/index')), originalIndex);
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  assert.deepEqual(execFileSync('git', ['show', `${published.branch}:binary.bin`], { cwd: f.root }), Buffer.from([0, 0xff, 0xfe, 13, 10]));
  assert.equal((await session.publish()).commit, published.commit);
  await session.undo();
  assert.equal(git(f.root, 'branch', '--list', published.branch), '');
  await assert.rejects(session.publish(), /Redo/);
  assert.equal((await session.redo()).commit, published.commit);
});

test('same base and proposal produce stable digest despite change-array order', async t => {
  const f = await fixture(t);
  const first = await f.session(), second = await f.session();
  const input = f.proposal();
  const a = await first.prepare(input);
  const b = await second.prepare({ ...input, changes: input.changes.toReversed() });
  assert.equal(a.proposal.digest, b.proposal.digest);
  a.proposal.changes[0].path = 'tampered';
  assert.equal((await first.status()).proposal.changes[0].path, 'delete.txt');
  const published = await first.publish();
  await first.undo();
  assert.equal((await second.publish()).commit, published.commit);
});

test('invalid/stale/replayed proposals preserve the prior preview', async t => {
  const f = await fixture(t);
  const session = await f.session();
  const prepared = await session.prepare(f.proposal());
  for (const name of ['../escape', '/tmp/escape', '.git/config', 'a/.GiT/config', 'a\\b', 'a//b']) {
    await assert.rejects(session.prepare(f.proposal([{ path: name, operation: 'write', text: 'unsafe' }], 'next')), /path/i);
  }
  await assert.rejects(session.prepare({ ...f.proposal(), id: 'stale', baseCommit: 'a'.repeat(40) }), /Stale/);
  await assert.rejects(session.prepare(f.proposal()), /ID already used/);
  await assert.rejects(session.prepare(f.proposal([{ path: 'binary.bin', operation: 'delete' }], 'binary')), /UTF-8/);
  await assert.rejects(session.prepare(f.proposal([{ path: 'new', operation: 'write', text: '\ud800' }], 'bad-utf16')), /UTF-8/);
  await assert.rejects(session.prepare(f.proposal([{ path: 'readme.md', operation: 'write', text: 'collision' }], 'case')), /Case-colliding/);
  assert.deepEqual(await session.status(), prepared);
});

test('connection rejects dirty, untracked, and assume-unchanged modifications', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'untracked'), 'x');
  await assert.rejects(f.session(), /untracked/);
  await fs.rm(path.join(f.root, 'untracked'));
  git(f.root, 'update-index', '--assume-unchanged', 'README.md');
  await fs.writeFile(path.join(f.root, 'README.md'), 'invisible to normal status');
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  await assert.rejects(f.session(), /Source file changed/);
});

test('source changes after preview refuse publication without changing the source', async t => {
  const f = await fixture(t);
  const session = await f.session();
  await session.prepare(f.proposal());
  await fs.writeFile(path.join(f.root, 'README.md'), 'later user work');
  await assert.rejects(session.publish(), /Source file changed/);
  assert.equal(await fs.readFile(path.join(f.root, 'README.md'), 'utf8'), 'later user work');
  assert.equal((await session.status()).state, 'prepared');
  assert.equal(git(f.root, 'branch', '--list', 'deterministic/*'), '');
});

test('staged edits and branch-context switches invalidate source', async t => {
  const f = await fixture(t);
  const session = await f.session();
  await session.prepare(f.proposal());
  git(f.root, 'switch', '-c', 'other');
  await assert.rejects(session.publish(), /HEAD changed/);
  git(f.root, 'switch', 'main');
  await fs.writeFile(path.join(f.root, 'README.md'), 'new');
  git(f.root, 'add', 'README.md');
  await assert.rejects(session.publish(), /index is dirty/);
});

test('configured checks must explicitly run and pass before publication', async t => {
  const f = await fixture(t);
  const session = await f.session([{ name: 'Check', argv: [process.execPath, '-e',
    "require('node:assert/strict').equal(require('node:fs').readFileSync('src/main.js','utf8'),'export const answer = 42;\\r\\n'); console.log('passed')"] }]);
  await session.prepare(f.proposal());
  await assert.rejects(session.publish(), /Every configured check must pass/);
  const checked = await session.runChecks();
  assert.equal(checked.checks[0].status, 'passed');
  assert.match(checked.checks[0].output, /passed/);
  const published = await session.publish();
  assert.equal(git(f.root, 'ls-tree', published.branch, 'generated.log'), '');
  assert.equal(git(f.root, 'status', '--porcelain'), '');
});

test('checks cannot pass using untracked helpers that would be omitted from publication', async t => {
  const f = await fixture(t);
  const session = await f.session([{ name: 'Generate', argv: [process.execPath, '-e',
    "require('node:fs').writeFileSync('helper.js','module.exports = 42'); require('node:assert/strict').equal(require('./helper.js'),42)"] }]);
  await session.prepare(f.proposal());
  const checked = await session.runChecks();
  assert.equal(checked.checks[0].status, 'error');
  assert.match(checked.checks[0].output, /Unexpected candidate file/);
  await assert.rejects(session.publish(), /must pass/);
});

test('failed checks and missing executables block publication, preserving original files', async t => {
  const f = await fixture(t);
  for (const [name, argv, expected] of [
    ['Fail', [process.execPath, '-e', "console.error('expected failure'); process.exit(2)"], 'failed'],
    ['Missing', [path.join(f.root, 'not-a-command')], 'error'],
  ]) {
    const session = await f.session([{ name, argv }]);
    await session.prepare(f.proposal());
    assert.equal((await session.runChecks()).checks[0].status, expected);
    await assert.rejects(session.publish(), /must pass/);
  }
  assert.equal(git(f.root, 'status', '--porcelain'), '');
});

test('mutating checks invalidate candidate even if their exit code is zero', async t => {
  const f = await fixture(t);
  const session = await f.session([{ name: 'Format', argv: [process.execPath, '-e',
    "require('node:fs').writeFileSync('README.md','formatter changed unrelated tracked file')"] }]);
  await session.prepare(f.proposal());
  const checked = await session.runChecks();
  assert.equal(checked.checks[0].status, 'error');
  assert.match(checked.checks[0].output, /Candidate changed after preview/);
  await assert.rejects(session.publish(), /must pass/);
  await assert.rejects(session.runChecks(), /Candidate changed/);
  assert.equal(await fs.readFile(path.join(f.root, 'README.md'), 'utf8'), '\uFEFFOriginal\n');
});

test('candidate changes after a successful check are refused, including reappearing deleted files', async t => {
  const f = await fixture(t);
  const session = await f.session();
  let prepared = await session.prepare(f.proposal());
  await session.runChecks();
  await fs.writeFile(path.join(prepared.candidatePath, 'src/main.js'), 'changed after review');
  await assert.rejects(session.publish(), /Candidate changed/);
  prepared = await session.prepare(f.proposal(undefined, 'review-2'));
  await fs.writeFile(path.join(prepared.candidatePath, 'delete.txt'), 'reappeared');
  await assert.rejects(session.publish(), /Deleted file reappeared/);
});

test('competing sessions cannot overwrite an existing publication branch', async t => {
  const f = await fixture(t);
  const first = await f.session(), second = await f.session();
  await Promise.all([first.prepare(f.proposal()), second.prepare(f.proposal())]);
  const results = await Promise.allSettled([first.publish(), second.publish()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(git(f.root, 'branch', '--list', 'deterministic/*').split('\n').length, 1);
});

test('Undo preserves a branch moved by the user, and Redo refuses a recreated name', async t => {
  const f = await fixture(t);
  const session = await f.session();
  await session.prepare(f.proposal());
  const published = await session.publish();
  const ref = `refs/heads/${published.branch}`;
  git(f.root, 'update-ref', ref, f.baseCommit, published.commit);
  await assert.rejects(session.undo(), /Git update-ref failed/);
  assert.equal(git(f.root, 'rev-parse', ref), f.baseCommit);
  git(f.root, 'update-ref', ref, published.commit, f.baseCommit);
  await session.undo();
  git(f.root, 'update-ref', ref, f.baseCommit, '0'.repeat(40));
  await assert.rejects(session.redo(), /Git update-ref failed/);
  assert.equal(git(f.root, 'rev-parse', ref), f.baseCommit);
  assert.equal((await session.status()).state, 'undone');
});

test('Undo refuses a branch checked out in another worktree', async t => {
  const f = await fixture(t);
  const session = await f.session();
  await session.prepare(f.proposal());
  const published = await session.publish();
  const other = path.join(path.dirname(f.root), `${path.basename(f.root)}-worktree`);
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  git(f.root, 'worktree', 'add', other, published.branch);
  await assert.rejects(session.undo(), /checked out/);
  assert.equal(git(f.root, 'rev-parse', published.branch), published.commit);
});

test('Undo refuses a branch already deleted outside the session', async t => {
  const f = await fixture(t);
  const session = await f.session();
  await session.prepare(f.proposal());
  const published = await session.publish();
  git(f.root, 'update-ref', '-d', `refs/heads/${published.branch}`, published.commit);
  await assert.rejects(session.undo(), /changed|missing|update-ref/);
  assert.equal((await session.status()).state, 'published');
});

test('Redo refuses a changed original project while retaining the reviewed commit', async t => {
  const f = await fixture(t);
  const session = await f.session();
  await session.prepare(f.proposal());
  const published = await session.publish();
  await session.undo();
  await fs.writeFile(path.join(f.root, 'README.md'), 'later work');
  await assert.rejects(session.redo(), /Source file changed/);
  assert.equal((await session.status()).commit, published.commit);
  assert.equal(await fs.readFile(path.join(f.root, 'README.md'), 'utf8'), 'later work');
});

test('symlinks and submodules in the tracked tree are rejected', async t => {
  if (process.platform === 'win32') return t.skip('symlink creation needs elevated privileges on Windows');
  const f = await fixture(t);
  await fs.symlink('README.md', path.join(f.root, 'link'));
  git(f.root, 'add', 'link'); git(f.root, 'commit', '-m', 'Symlink');
  await assert.rejects(f.session(), /Symlinks, submodules/);
  git(f.root, 'rm', 'link'); git(f.root, 'commit', '-m', 'Remove symlink');
  git(f.root, 'update-index', '--add', '--cacheinfo', `160000,${f.baseCommit},vendor/module`);
  git(f.root, 'commit', '-m', 'Gitlink');
  await assert.rejects(f.session(), /Symlinks, submodules/);
});

test('fixed size limits reject oversized proposals without discarding the previous review', async t => {
  const f = await fixture(t);
  const session = await f.session();
  const before = await session.prepare(f.proposal());
  await assert.rejects(session.prepare(f.proposal([
    { path: 'huge.txt', operation: 'write', text: 'x'.repeat(PROJECT_LIMITS.bytes + 1) },
  ], 'huge')), /exceeds/);
  assert.equal((await session.status()).proposal.digest, before.proposal.digest);
});

test('check logs are bounded and close leaves a published branch intact', async t => {
  const f = await fixture(t);
  const session = await f.session([{ name: 'Verbose', argv: [process.execPath, '-e',
    "process.stdout.write('x'.repeat(100000))"] }]);
  const prepared = await session.prepare(f.proposal());
  const checked = await session.runChecks();
  assert.equal(checked.checks[0].status, 'passed');
  assert.ok(checked.checks[0].output.length <= PROJECT_LIMITS.checkOutputBytes + 32);
  assert.match(checked.checks[0].output, /output truncated/);
  const published = await session.publish();
  await session.close();
  await assert.rejects(fs.stat(prepared.candidatePath), { code: 'ENOENT' });
  await assert.rejects(session.status(), /closed/);
  assert.equal(git(f.root, 'rev-parse', published.branch), published.commit);
});

test('a non-terminating check is killed at the fixed deadline and cannot publish', { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  const session = await f.session([{ name: 'Hanging', argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] }]);
  await session.prepare(f.proposal());
  assert.equal((await session.runChecks()).checks[0].status, 'timeout');
  await assert.rejects(session.publish(), /must pass/);
});
