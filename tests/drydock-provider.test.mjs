import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/core/canonical.mjs';
import { scanDrydock, validateDrydockConfig, DRYDOCK_LIMITS } from '../src/project/drydock.mjs';

const report = () => ({ engine_version: 'fixture-1', runtime_verified: false,
  catalog: { sha256: 'c'.repeat(64), stale: true },
  snapshot: { sha256: 'd'.repeat(64), files: 2, bytes: 40, excluded: { directories: 1 } },
  checks_run: ['secrets'], checks_not_run: [{ check: 'xss', reason: 'native_parser_unavailable' }],
  findings: [{ rule_id: 'dependency-cve-match', applicability: 'unknown' }],
  limitations: ['static_source_only', 'native_parsers_unavailable'],
  dependency_cve: { status: 'partial', status_counts: { unknown: 1 } },
});

async function fixture(t, body) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'det-drydock-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidatePath = path.join(root, 'candidate');
  const repository = path.join(root, 'scanner');
  await fs.mkdir(candidatePath); await fs.mkdir(repository);
  const executable = path.join(root, 'trusted-scanner');
  await fs.writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return { config: { python: executable, repository }, candidatePath,
    candidateDigest: 'a'.repeat(64), proposalDigest: 'b'.repeat(64) };
}

test('startup config is detached, exact and absolute', () => {
  const value = { python: '/trusted/python', repository: '/trusted/repository' };
  const frozen = validateDrydockConfig(value); value.python = '/different';
  assert.equal(frozen.python, '/trusted/python'); assert.equal(Object.isFrozen(frozen), true);
  for (const invalid of [{ ...value, python: 'python' }, { ...value, extra: true }, null])
    assert.throws(() => validateDrydockConfig(invalid));
});

test('valid partial report preserves unknown findings, exclusions and exact bindings', async t => {
  const original = report();
  const input = await fixture(t, `process.stdout.write(${JSON.stringify(JSON.stringify(original))}); process.exitCode=2;`);
  const result = await scanDrydock(input);
  assert.equal(result.assessmentStatus, 'partial');
  assert.equal(result.candidateDigest, input.candidateDigest);
  assert.equal(result.proposalDigest, input.proposalDigest);
  assert.notEqual(result.scannerSnapshotSha256, result.candidateDigest);
  assert.deepEqual(result.report, original);
  const { reportDigest, ...envelope } = result;
  assert.equal(reportDigest, createHash('sha256').update(canonicalJson(envelope)).digest('hex'));
});

test('malformed JSON, invalid UTF-8, missing provenance and execution claims fail closed', async t => {
  for (const body of [
    'process.stdout.write("not json");',
    'process.stdout.write(Buffer.from([0xff]));',
    `process.stdout.write(${JSON.stringify(JSON.stringify({ ...report(), catalog: {} }))});`,
    `process.stdout.write(${JSON.stringify(JSON.stringify({ ...report(), runtime_verified: true }))});`,
    `process.stdout.write(${JSON.stringify(JSON.stringify(report()))}); process.exitCode=3;`,
  ]) await assert.rejects(scanDrydock(await fixture(t, body)), /Drydock:/);
});

test('scanner runs outside candidate with clean Python search path and external disposable state', async t => {
  const input = await fixture(t, `const fs=require('node:fs');
const args=process.argv.slice(2);const state=args[args.indexOf('--state-dir')+1];
fs.writeFileSync('invocation.json',JSON.stringify({args,cwd:process.cwd(),state,pythonpath:process.env.PYTHONPATH}));
process.stdout.write(${JSON.stringify(JSON.stringify(report()))});`);
  const previous = process.env.PYTHONPATH;
  process.env.PYTHONPATH = input.candidatePath;
  try { await scanDrydock(input); }
  finally { if (previous === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = previous; }
  const call = JSON.parse(await fs.readFile(path.join(input.config.repository, 'invocation.json'), 'utf8'));
  assert.equal(call.cwd, input.config.repository); assert.equal(call.pythonpath, undefined);
  assert.deepEqual(call.args.slice(0, 2), ['-m', 'app.local_cli']);
  assert.ok(call.args.includes(input.candidatePath)); assert.ok(!call.state.startsWith(input.candidatePath));
  await assert.rejects(fs.stat(call.state), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(input.candidatePath), []);
});

test('timeout and combined output cap reject rather than returning truncated evidence', async t => {
  await assert.rejects(scanDrydock(await fixture(t, 'setInterval(()=>{},1000);'), { timeoutMs: 100 }), /timeout/);
  await assert.rejects(scanDrydock(await fixture(t, 'process.stderr.write("x".repeat(4096)); setInterval(()=>{},1000);'),
    { maxOutputBytes: 1024 }), /output limit/);
  await assert.rejects(scanDrydock(await fixture(t, 'process.exit(0);'),
    { timeoutMs: DRYDOCK_LIMITS.timeoutMs + 1 }), /invalid timeoutMs/);
});

test('scanner checkout inside candidate and invalid digests are rejected before launch', async t => {
  const input = await fixture(t, 'process.exit(99);');
  await assert.rejects(scanDrydock({ ...input, config: { ...input.config, repository: input.candidatePath } }), /inside the candidate/);
  await assert.rejects(scanDrydock({ ...input, candidateDigest: '' }), /digests are required/);
  const candidateProgram = path.join(input.candidatePath, 'python');
  await fs.writeFile(candidateProgram, '#!/bin/sh\nexit 99\n', {mode:0o755});
  await assert.rejects(scanDrydock({ ...input, config:{...input.config, python:candidateProgram} }), /executable must not be inside/);
});
