// Trusted local tool adapter. Candidate files are inputs to static analysis only.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../core/canonical.mjs';

export const DRYDOCK_LIMITS = Object.freeze({ timeoutMs: 120_000, maxOutputBytes: 2 * 1024 * 1024 });
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const fail = message => { throw new Error(`Drydock: ${message}`); };
const inside = (directory, child) => {
  const relative = path.relative(directory, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export function validateDrydockConfig(config) {
  if (!isObject(config) || Object.keys(config).sort().join(',') !== 'python,repository') fail('invalid startup configuration');
  for (const key of ['python', 'repository']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key]) || config[key].length > 4096
        || config[key].includes('\0') || !config[key].isWellFormed()) fail(`${key} must be an absolute local path`);
  }
  // Preserve the Python path rather than resolving its symlink: a venv executable
  // can point to the system interpreter while relying on its invocation location.
  return Object.freeze({ python: path.resolve(config.python), repository: path.resolve(config.repository) });
}

function validateReport(report) {
  const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  const count = value => Number.isSafeInteger(value) && value >= 0;
  if (!isObject(report) || report.error !== undefined || report.runtime_verified !== false
      || typeof report.engine_version !== 'string' || !report.engine_version || report.engine_version.length > 256
      || !isObject(report.catalog) || !isDigest(report.catalog.sha256)
      || !isObject(report.snapshot) || !isDigest(report.snapshot.sha256)
      || !count(report.snapshot.files) || !count(report.snapshot.bytes)
      || !isObject(report.snapshot.excluded) || !Object.values(report.snapshot.excluded).every(count)
      || !Array.isArray(report.findings) || !report.findings.every(isObject)
      || !strings(report.checks_run) || !Array.isArray(report.checks_not_run)
      || !report.checks_not_run.every(item => isObject(item) && typeof item.check === 'string' && typeof item.reason === 'string')
      || !strings(report.limitations)) fail('invalid or incomplete JSON report');
  // Also reject non-canonical JSON values such as 1e999 that JSON.parse accepts.
  canonicalJson(report);
}

function run(argv, { cwd, env, timeoutMs, maxOutputBytes }) {
  return new Promise((resolve, reject) => {
    let child, timer, failure = null, bytes = 0;
    const stdout = [], stderr = [];
    const stop = () => {
      if (!child?.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* already exited */ }
    };
    const collect = chunks => data => {
      bytes += data.length;
      if (bytes > maxOutputBytes) {
        failure ??= 'output limit exceeded';
        stop();
      } else if (!failure) chunks.push(data);
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false,
        detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { reject(new Error(`Drydock: could not start scanner (${error.code || 'spawn error'})`)); return; }
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', error => { failure ??= `could not start scanner (${error.code || 'spawn error'})`; });
    timer = setTimeout(() => { failure ??= 'scanner timeout'; stop(); }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      stop(); // Close any surviving children, including ones that closed their pipes.
      if (failure) reject(new Error(`Drydock: ${failure}`));
      else if (signal || ![0, 1, 2].includes(code)) reject(new Error(`Drydock: scanner exited with ${signal || code}`));
      else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

/**
 * The engine must verify the complete candidate immediately before and after this
 * call. Drydock's own snapshot hash has a different exclusion policy and is NOT
 * interchangeable with the complete project candidateDigest supplied here.
 * Bounds may be reduced (for tests or a stricter caller), never increased.
 */
export async function scanDrydock({ config, candidatePath, candidateDigest, proposalDigest }, bounds = {}) {
  const configured = validateDrydockConfig(config);
  if (!isDigest(candidateDigest) || !isDigest(proposalDigest)) fail('candidate and proposal SHA-256 digests are required');
  if (typeof candidatePath !== 'string' || !path.isAbsolute(candidatePath)) fail('candidatePath must be absolute');
  if (!isObject(bounds) || Object.keys(bounds).some(key => !Object.hasOwn(DRYDOCK_LIMITS, key))) fail('invalid execution bounds');
  const limits = { ...DRYDOCK_LIMITS, ...bounds };
  for (const key of Object.keys(DRYDOCK_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DRYDOCK_LIMITS[key]) fail(`invalid ${key}`);
  }
  if (process.platform === 'win32') fail('this adapter requires POSIX process-group termination');
  const candidate = await fs.realpath(candidatePath);
  const repository = await fs.realpath(configured.repository);
  if (!(await fs.stat(candidate)).isDirectory() || !(await fs.stat(repository)).isDirectory()) fail('candidate and repository must be directories');
  if (inside(candidate, repository)) fail('scanner checkout must not be inside the candidate');
  const interpreter = await fs.realpath(configured.python);
  if (inside(candidate, configured.python) || inside(candidate, interpreter)) fail('Python executable must not be inside the candidate');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'det-drydock-'));
  try {
    if (inside(candidate, temporary)) fail('scanner state must be outside the candidate');
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('PYTHON')) delete env[key];
    env.PYTHONNOUSERSITE = '1';
    env.PYTHONDONTWRITEBYTECODE = '1';
    const result = await run([configured.python, '-m', 'app.local_cli', '--state-dir', temporary,
      'scan', candidate, '--json'], { cwd: repository, env, ...limits });
    let report;
    try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)); }
    catch { fail('scanner did not return one valid UTF-8 JSON report'); }
    validateReport(report);
    const evidence = {
      schemaVersion: 1, provider: 'drydock', scope: 'project_snapshot',
      candidateDigest, proposalDigest, engineVersion: report.engine_version,
      catalogSha256: report.catalog.sha256, scannerSnapshotSha256: report.snapshot.sha256,
      assessmentStatus: 'partial', report,
    };
    const serialized = canonicalJson(evidence);
    if (Buffer.byteLength(serialized, 'utf8') + 100 > DRYDOCK_LIMITS.maxOutputBytes) fail('evidence limit exceeded');
    return { ...evidence, reportDigest: createHash('sha256').update(serialized).digest('hex') };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
