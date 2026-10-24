import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProjectSession } from '../src/project/engine.mjs';
import { startProjectServer } from '../src/project/server.mjs';

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=Drydock Integration Test',
    '-c', 'user.email=drydock-test@example.invalid', '-c', 'commit.gpgSign=false',
    '-c', `core.hooksPath=${os.devNull}`, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull } }).trim();
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-drydock-test-'));
  const projectPath = path.join(directory, 'project');
  const repository = path.join(directory, 'scanner');
  await fs.mkdir(projectPath); await fs.mkdir(repository);
  await fs.mkdir(path.join(projectPath, 'src'));
  await fs.writeFile(path.join(projectPath, 'src/main.js'), 'export const answer = 1;\r\n');
  await fs.writeFile(path.join(projectPath, 'README.md'), '\uFEFFOriginal\n');
  await fs.writeFile(path.join(projectPath, 'package.json'), '{"name":"evidence-fixture","version":"1.0.0"}\n');
  await fs.writeFile(path.join(projectPath, 'package-lock.json'), '{"name":"evidence-fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"evidence-fixture","version":"1.0.0"}}}\n');
  git(projectPath, 'init', '-b', 'main'); git(projectPath, 'config', 'core.autocrlf', 'false');
  git(projectPath, 'add', '.'); git(projectPath, 'commit', '-m', 'Base');
  const baseCommit = git(projectPath, 'rev-parse', 'HEAD');
  const python = path.join(directory, 'trusted-scanner');
  await fs.writeFile(python, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const mode=JSON.parse(fs.readFileSync('mode.json','utf8'));
const args=process.argv.slice(2),candidate=args[args.indexOf('scan')+1];
if(mode.mutate)fs.writeFileSync(path.join(candidate,'src/main.js'),'scanner changed candidate');
if(mode.invalid){process.stdout.write('{}');process.exit(0);}
const count=fs.existsSync('count')?Number(fs.readFileSync('count','utf8'))+1:1;
fs.writeFileSync('count',String(count));
process.stdout.write(JSON.stringify({engine_version:'fixture-1',runtime_verified:false,
 catalog:{sha256:'c'.repeat(64),stale:true},snapshot:{sha256:'d'.repeat(64),files:4,bytes:180,excluded:{directories:1}},
 findings:[{rule_id:'dependency-cve-match',applicability:'unknown'}],checks_run:['secrets'],
 checks_not_run:[{check:'xss',reason:'native_parser_unavailable'}],
 limitations:['static_source_only','native_parsers_unavailable'],
 dependency_cve:{status:'partial',status_counts:{unknown:1}},test_run:count}));
process.exitCode=2;
`, { mode: 0o755 });
  await fs.writeFile(path.join(repository, 'mode.json'), '{}');
  const sessions = [], servers = [];
  t.after(async () => {
    for (const server of servers) await server.close();
    for (const session of sessions) await session.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  const drydock = { python, repository };
  return {
    projectPath, baseCommit, drydock,
    async session(extra = {}) {
      const session = await createProjectSession({ projectPath, drydock, ...extra });
      sessions.push(session); return session;
    },
    async server() {
      const server = await startProjectServer({ projectPath, drydock });
      servers.push(server); return server;
    },
    async mode(value) { await fs.writeFile(path.join(repository, 'mode.json'), JSON.stringify(value)); },
    proposal(id = 'task-1', answer = 42) {
      return { schemaVersion: 1, id, title: 'Review project changes', baseCommit,
        changes: [
          { path: 'src/main.js', operation: 'write', text: `export const answer = ${answer};\r\n` },
          { path: 'README.md', operation: 'write', text: '\uFEFFReviewed\n' },
        ] };
    },
  };
}

const approval = status => ({ expectedEvidenceDigest: status.drydock.evidence.reportDigest });
const noBranch = root => assert.equal(git(root, 'branch', '--list', 'deterministic/*'), '');

test('configured provider requires a current reviewed digest and preserves partial findings through publication', async t => {
  const f = await fixture(t), session = await f.session();
  const indexBefore = await fs.readFile(path.join(f.projectPath, '.git/index'));
  const prepared = await session.prepare(f.proposal());
  assert.match(prepared.proposal.candidateSnapshotDigest, /^[a-f0-9]{64}$/u);
  await assert.rejects(session.publish(), /Drydock evidence/);
  const scanned = await session.runDrydock();
  assert.equal(scanned.drydock.state, 'completed');
  assert.equal(scanned.drydock.evidence.candidateDigest, prepared.proposal.candidateSnapshotDigest);
  assert.equal(scanned.drydock.evidence.proposalDigest, prepared.proposal.digest);
  assert.equal(scanned.drydock.evidence.assessmentStatus, 'partial');
  assert.equal(scanned.drydock.evidence.report.findings[0].applicability, 'unknown');
  assert.equal(scanned.drydock.evidence.report.snapshot.excluded.directories, 1);
  assert.equal(scanned.drydock.evidence.report.checks_not_run[0].reason, 'native_parser_unavailable');
  await assert.rejects(session.publish(), /Drydock evidence/);
  await assert.rejects(session.publish({ expectedEvidenceDigest: '0'.repeat(64) }), /Drydock evidence/);
  noBranch(f.projectPath);
  const published = await session.publish(approval(scanned));
  assert.equal(published.state, 'published');
  assert.equal(git(f.projectPath, 'show', `${published.branch}:src/main.js`), 'export const answer = 42;');
  assert.equal(git(f.projectPath, 'rev-parse', 'HEAD'), f.baseCommit);
  assert.equal(await fs.readFile(path.join(f.projectPath, 'src/main.js'), 'utf8'), 'export const answer = 1;\r\n');
  assert.deepEqual(await fs.readFile(path.join(f.projectPath, '.git/index')), indexBefore);
  assert.equal(git(f.projectPath, 'status', '--porcelain'), '');
});

test('Drydock evidence does not replace configured checks, and rechecking invalidates previous evidence', async t => {
  const f = await fixture(t);
  const session = await f.session({ checks: [{ name: 'Trusted test', argv: [process.execPath, '-e', 'process.exit(0)'] }] });
  await session.prepare(f.proposal());
  const first = await session.runDrydock();
  await assert.rejects(session.publish(approval(first)), /Every configured check/);
  const checked = await session.runChecks();
  assert.equal(checked.checks[0].status, 'passed');
  assert.equal(checked.drydock.state, 'not-run');
  assert.equal(checked.drydock.evidence, null);
  await assert.rejects(session.publish(approval(first)), /Drydock evidence/);
  const current = await session.runDrydock();
  assert.notEqual(current.drydock.evidence.reportDigest, first.drydock.evidence.reportDigest);
  await assert.rejects(session.publish(approval(first)), /Drydock evidence/);
  assert.equal((await session.publish(approval(current))).state, 'published');
});

test('a new proposal invalidates old evidence even when a stale tab remembers its digest', async t => {
  const f = await fixture(t), session = await f.session();
  await session.prepare(f.proposal());
  const first = await session.runDrydock();
  const next = await session.prepare(f.proposal('task-2', 99));
  assert.notEqual(next.proposal.candidateSnapshotDigest, first.proposal.candidateSnapshotDigest);
  assert.equal(next.drydock.state, 'not-run'); assert.equal(next.drydock.evidence, null);
  await assert.rejects(session.publish(approval(first)), /Drydock evidence/);
  const current = await session.runDrydock();
  await assert.rejects(session.publish(approval(first)), /Drydock evidence/);
  assert.equal((await session.publish(approval(current))).state, 'published');
});

test('changes during a scan or malformed reports cannot leave publishable evidence', async t => {
  const f = await fixture(t), session = await f.session();
  await session.prepare(f.proposal());
  await f.mode({ mutate: true });
  const changed = await session.runDrydock();
  assert.equal(changed.drydock.state, 'failed'); assert.equal(changed.drydock.evidence, null);
  assert.match(changed.drydock.error, /Candidate changed/);
  await assert.rejects(session.publish({ expectedEvidenceDigest: 'a'.repeat(64) }), /Drydock evidence/);
  await session.prepare(f.proposal('task-2'));
  await f.mode({ invalid: true });
  const invalid = await session.runDrydock();
  assert.equal(invalid.drydock.state, 'failed'); assert.equal(invalid.drydock.evidence, null);
  await assert.rejects(session.publish(), /Drydock evidence/);
  noBranch(f.projectPath);
});

test('candidate mutation after scanning still blocks publication with the correct evidence digest', async t => {
  const f = await fixture(t), session = await f.session();
  const prepared = await session.prepare(f.proposal());
  const scanned = await session.runDrydock();
  await fs.writeFile(path.join(prepared.candidatePath, 'src/main.js'), 'changed after report');
  await assert.rejects(session.publish(approval(scanned)), /Candidate changed/);
  noBranch(f.projectPath);
  assert.equal(await fs.readFile(path.join(f.projectPath, 'src/main.js'), 'utf8'), 'export const answer = 1;\r\n');
});

test('HTTP cannot bypass mandatory evidence or apply a report from another proposal', async t => {
  const f = await fixture(t), server = await f.server();
  const url = new URL(server.url);
  const headers = { Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get('token')}`, 'Content-Type': 'application/json' };
  const post = (action, body) => fetch(`${url.origin}/api/${action}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const prepared = await (await post('prepare', f.proposal())).json();
  assert.equal((await post('drydock', {})).status, 400);
  assert.equal((await post('drydock', { expectedDigest: 'stale' })).status, 409);
  assert.equal((await post('publish', { expectedDigest: prepared.proposal.digest })).status, 409);
  const scannedResponse = await post('drydock', { expectedDigest: prepared.proposal.digest });
  assert.equal(scannedResponse.status, 200);
  const scanned = await scannedResponse.json(); assert.equal(scanned.drydock.state, 'completed');
  assert.equal((await post('publish', { expectedDigest: prepared.proposal.digest, expectedEvidenceDigest: 'bad' })).status, 409);
  const next = await (await post('prepare', f.proposal('task-2', 101))).json();
  assert.equal(next.drydock.evidence, null);
  assert.equal((await post('publish', { expectedDigest: prepared.proposal.digest, ...approval(scanned) })).status, 409);
  assert.equal((await post('publish', { expectedDigest: next.proposal.digest, ...approval(scanned) })).status, 409);
  const current = await (await post('drydock', { expectedDigest: next.proposal.digest })).json();
  const publishedResponse = await post('publish', { expectedDigest: next.proposal.digest, ...approval(current) });
  assert.equal(publishedResponse.status, 200);
  const published = await publishedResponse.json(); assert.equal(published.state, 'published');
  assert.equal(git(f.projectPath, 'show', `${published.branch}:src/main.js`), 'export const answer = 101;');
});

test('optional real Drydock scans the entire multi-file candidate and keeps original project untouched', {
  skip: !process.env.DRYDOCK_REAL_PYTHON || !process.env.DRYDOCK_REAL_REPOSITORY,
}, async t => {
  const f = await fixture(t);
  const session = await f.session({ drydock: { python: process.env.DRYDOCK_REAL_PYTHON, repository: process.env.DRYDOCK_REAL_REPOSITORY } });
  const prepared = await session.prepare(f.proposal());
  const scanned = await session.runDrydock();
  assert.equal(scanned.drydock.state, 'completed', scanned.drydock.error);
  assert.equal(scanned.drydock.evidence.report.snapshot.files, 4);
  assert.equal(scanned.drydock.evidence.candidateDigest, prepared.proposal.candidateSnapshotDigest);
  assert.equal(scanned.drydock.evidence.assessmentStatus, 'partial');
  const published = await session.publish(approval(scanned));
  assert.equal(git(f.projectPath, 'rev-parse', 'HEAD'), f.baseCommit);
  assert.equal(git(f.projectPath, 'status', '--porcelain'), '');
  assert.equal(git(f.projectPath, 'ls-tree', '-r', '--name-only', published.branch).split('\n').length, 4);
});
