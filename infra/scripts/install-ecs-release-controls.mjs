#!/usr/bin/env node
// Operator-only installation of independently reviewed control-plane bytes.
// Does not generate keys, sign evidence, deploy containers, or modify data.
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONTROLS = Object.freeze({
  backup: Object.freeze({ executable: 'attest-postgres-backup', digest: 'production-backup-attester-sha256' }),
  restore: Object.freeze({ executable: 'restore-pg17-isolated', digest: 'production-pg17-restore-runner-sha256' }),
  preidentity: Object.freeze({ executable: 'ecs-preidentity-recovery', digest: 'production-preidentity-recovery-sha256' }),
  capability: Object.freeze({ executable: 'attest-capability-evidence', digest: 'production-capability-attester-sha256' }),
  manual: Object.freeze({ executable: 'attest-manual-operations-evidence', digest: 'production-manual-operations-attester-sha256' }),
  bundle: Object.freeze({ executable: 'attest-release-evidence-bundle', digest: 'production-evidence-bundle-attester-sha256' }),
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

export function prepareControlBytes(control, bytes, sourceSha, nodePath) {
  ensure(Object.hasOwn(CONTROLS, control), 'unknown release control');
  ensure(/^[a-f0-9]{64}$/.test(sourceSha) && hash(bytes) === sourceSha, 'reviewed source checksum mismatch');
  ensure(/^\/[A-Za-z0-9._/-]+$/.test(nodePath) && resolve(nodePath) === nodePath, 'runtime must be a canonical absolute path');
  const text = bytes.toString('utf8');
  ensure(text.startsWith('#!') && text.includes('\n') && !text.includes('\0'), 'control must have a valid script header');
  return Buffer.from(`#!${nodePath}\n${text.slice(text.indexOf('\n') + 1)}`);
}

export function assertProtectedPath(path, owner = 0) {
  ensure(resolve(path) === path && realpathSync(path) === path, 'protected path must be canonical');
  let cursor = path;
  while (true) {
    const st = lstatSync(cursor);
    ensure(!st.isSymbolicLink() && st.uid === owner && (st.mode & 0o022) === 0, 'unsafe protected path ownership or mode');
    if (cursor === '/') break;
    cursor = dirname(cursor);
  }
}

function readProtected(path, maxBytes) {
  assertProtectedPath(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    ensure(st.isFile() && st.uid === 0 && (st.mode & 0o022) === 0 && st.size > 0 && st.size <= maxBytes, 'unsafe control input');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function atomicFile(path, bytes, mode, replace) {
  const temp = join(dirname(path), `.control-${randomUUID()}.tmp`);
  const fd = openSync(temp, 'wx', mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if (replace) renameSync(temp, path);
    else linkSync(temp, path);
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

export function parseInstallArguments(args) {
  const allowed = new Set(['--control', '--source', '--source-sha256', '--node', '--node-sha256']);
  const values = {};
  ensure(args.length === allowed.size * 2, 'exact installation arguments required');
  for (let i = 0; i < args.length; i += 2) {
    ensure(allowed.has(args[i]) && !Object.hasOwn(values, args[i]) && args[i + 1], 'unknown or duplicate installation argument');
    values[args[i]] = args[i + 1];
  }
  return values;
}

function main(args) {
  ensure(process.getuid?.() === 0 && process.geteuid?.() === 0, 'installation requires root');
  ensure(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'use a clean protected Node environment');
  const options = parseInstallArguments(args);
  const source = options['--source'], nodePath = options['--node'];
  const bytes = readProtected(source, 2 * 1024 * 1024);
  const runtime = readProtected(nodePath, 256 * 1024 * 1024);
  ensure(/^[a-f0-9]{64}$/.test(options['--node-sha256']) && hash(runtime) === options['--node-sha256'], 'reviewed Node checksum mismatch');
  ensure((lstatSync(nodePath).mode & 0o111) !== 0, 'protected Node is not executable');
  const installed = prepareControlBytes(options['--control'], bytes, options['--source-sha256'], nodePath);
  const binding = CONTROLS[options['--control']];
  const executableDir = '/usr/local/libexec/merchant';
  const trustDir = '/run/release-security/evidence-trust';
  const stateDir = '/var/lib/merchant-release-security';
  for (const path of [executableDir, trustDir, stateDir]) assertProtectedPath(path);
  const lock = join(stateDir, 'control-install.lock');
  mkdirSync(lock, { mode: 0o700 }); // Never steal an existing/stale lock.
  try {
    const history = join(stateDir, 'control-install-history');
    try { mkdirSync(history, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    assertProtectedPath(history);
    const output = join(executableDir, binding.executable), digestPath = join(trustDir, binding.digest);
    let previousSha = null;
    for (const path of [output, digestPath]) {
      let previous;
      try { previous = readProtected(path, 2 * 1024 * 1024); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (path === output) previousSha = hash(previous);
      const archived = join(history, `${path === output ? binding.executable : binding.digest}-${hash(previous)}`);
      try { atomicFile(archived, previous, 0o400, false); } catch (error) {
        if (error.code !== 'EEXIST' || !readProtected(archived, 2 * 1024 * 1024).equals(previous)) throw error;
      }
    }
    const installedSha = hash(installed);
    // A crash between these two replacements fails closed on the digest check.
    atomicFile(output, installed, 0o755, true);
    atomicFile(digestPath, Buffer.from(`${installedSha}\n`), 0o444, true);
    ensure(readProtected(output, 2 * 1024 * 1024).equals(installed), 'installed control readback mismatch');
    ensure(readProtected(digestPath, 128).toString().trim() === installedSha, 'installed digest readback mismatch');
    const receipt = { schema_version: 'ecs-control-install/1', control: options['--control'], source_sha256: options['--source-sha256'], installed_sha256: installedSha, previous_sha256: previousSha, node_path: nodePath, node_sha256: hash(runtime), installed_at: new Date().toISOString() };
    atomicFile(join(history, `${binding.executable}-${randomUUID()}.json`), Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`), 0o600, false);
    console.log(JSON.stringify(receipt));
  } finally { rmdirSync(lock); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch { console.error('protected control installation rejected; no deployment was performed'); process.exitCode = 1; }
}
