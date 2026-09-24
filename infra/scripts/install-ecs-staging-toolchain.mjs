#!/usr/bin/env node
// Install the candidate-bound staging script and its shared build lock as one
// immutable generation. A single current symlink switches both files.
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STAGING = 'infra/scripts/stage-verified-ecs-release.sh';
const LOCK = 'infra/scripts/ecs-build-lock.sh';
const STAGING_NODE = '/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node';
const STAGING_NPM_CLI = '/usr/lib/node_modules/npm/bin/npm-cli.js';
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const LAUNCHER = `#!/bin/sh
set -eu
PATH=/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin:/usr/bin:/bin
export PATH
unset NODE_OPTIONS NODE_PATH
candidate_bundle=\${ECS_CANDIDATE_BUNDLE_DIR:-}
releases_root=\${ECS_RELEASES_ROOT:-}
release_id=\${RELEASE_ID:-}
[ -n "$candidate_bundle" ] && [ -n "$releases_root" ] && [ -n "$release_id" ] || { echo 'staging inputs are incomplete' >&2; exit 2; }
control_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
toolchain="$control_root/staging-toolchain"
[ -L "$toolchain/current" ] || { echo 'no verified ECS staging toolchain is active' >&2; exit 2; }
target=$(readlink -f "$toolchain/current/infra/scripts/stage-verified-ecs-release.sh")
case "$target" in "$toolchain"/versions/*/infra/scripts/stage-verified-ecs-release.sh) ;; *) echo 'active ECS staging toolchain escaped its protected root' >&2; exit 2 ;; esac
[ -f "$target" ] && [ ! -L "$target" ] || { echo 'active ECS staging helper is unavailable' >&2; exit 2; }
exec /usr/bin/env -i "PATH=$PATH" "ECS_CANDIDATE_BUNDLE_DIR=$candidate_bundle" "ECS_RELEASES_ROOT=$releases_root" "RELEASE_ID=$release_id" "$target" "$@"
`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ensure = (ok, message) => { if (!ok) throw new Error(message); };

export function parseCandidateIdentity(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const index = line.indexOf('=');
    ensure(index > 0, 'malformed candidate identity');
    const key = line.slice(0, index), value = line.slice(index + 1);
    ensure(!values.has(key), `duplicate candidate identity field: ${key}`);
    values.set(key, value);
  }
  for (const key of ['git_sha', 'source_sha256', 'comparison_manifest_sha256', 'sync_plan_sha256']) ensure(values.has(key), `candidate identity missing ${key}`);
  if (values.has('release_id')) ensure(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(values.get('release_id')), 'invalid candidate release ID');
  ensure(/^[a-f0-9]{40}$/.test(values.get('git_sha')), 'invalid candidate Git SHA');
  for (const key of ['source_sha256', 'comparison_manifest_sha256', 'sync_plan_sha256']) ensure(/^sha256:[a-f0-9]{64}$/.test(values.get(key)), `invalid candidate ${key}`);
  return Object.fromEntries(values);
}

function mode(st) { return st.mode & 0o777; }
function assertDirectory(path, ownerUid) {
  ensure(resolve(path) === path && realpathSync(path) === path, 'protected directory must be canonical');
  let cursor = path;
  while (true) {
    const st = lstatSync(cursor);
    ensure(st.isDirectory() && !st.isSymbolicLink(), 'protected directory contains a symlink or non-directory');
    ensure(st.uid === ownerUid || (cursor !== path && st.uid === 0), 'protected directory has unexpected owner');
    ensure((st.mode & 0o022) === 0 || ((st.mode & 0o1000) !== 0 && cursor !== path), 'protected directory is writable by group/other');
    if (cursor === '/') break;
    cursor = dirname(cursor);
  }
  const st = lstatSync(path);
  ensure((st.mode & 0o077) === 0, 'toolchain control root must be private');
}
function assertProtectedFile(path, ownerUid, maxBytes) {
  ensure(resolve(path) === path && realpathSync(path) === path, 'input path must be canonical');
  let cursor = dirname(path);
  while (true) {
    const st = lstatSync(cursor);
    ensure(st.isDirectory() && !st.isSymbolicLink(), 'input parent must be a real directory');
    ensure(st.uid === ownerUid || (cursor !== dirname(path) && st.uid === 0), 'input parent has unexpected owner');
    ensure((st.mode & 0o022) === 0 || ((st.mode & 0o1000) !== 0 && cursor !== dirname(path)), 'input parent is writable by group/other');
    if (cursor === '/') break;
    cursor = dirname(cursor);
  }
  const st = lstatSync(path);
  ensure(st.isFile() && !st.isSymbolicLink() && st.uid === ownerUid && (st.mode & 0o077) === 0 && st.size > 0 && st.size <= maxBytes, 'input must be a private regular file owned by the operator');
}
export function snapshotProtectedArchive(sourcePath, controlRoot, ownerUid = process.getuid()) {
  assertProtectedFile(sourcePath, ownerUid, MAX_ARCHIVE_BYTES);
  assertDirectory(controlRoot, ownerUid);
  const sourceFd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const snapshotPath = join(controlRoot, `.candidate-source-${randomUUID()}.tar`);
  let snapshotFd;
  try {
    const before = fstatSync(sourceFd, { bigint: true });
    ensure(before.isFile() && before.uid === BigInt(ownerUid) && (before.mode & 0o077n) === 0n && before.size > 0n && before.size <= BigInt(MAX_ARCHIVE_BYTES), 'candidate archive changed or is unsafe');
    snapshotFd = openSync(snapshotPath, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let copied = 0n;
    while (true) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      copied += BigInt(count);
      ensure(copied <= BigInt(MAX_ARCHIVE_BYTES), 'candidate archive exceeds the size limit');
      let offset = 0;
      while (offset < count) offset += writeSync(snapshotFd, buffer, offset, count - offset);
    }
    const after = fstatSync(sourceFd, { bigint: true });
    ensure(copied === before.size && before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'candidate archive changed while being snapshotted');
    fsyncSync(snapshotFd);
    return snapshotPath;
  } catch (error) {
    try { unlinkSync(snapshotPath); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
    throw error;
  } finally {
    if (snapshotFd !== undefined) closeSync(snapshotFd);
    closeSync(sourceFd);
  }
}
function assertTrustedExecutable(path) {
  const resolved = realpathSync(path);
  const st = lstatSync(resolved);
  ensure(st.isFile() && st.uid === 0 && (st.mode & 0o111) !== 0 && (st.mode & 0o022) === 0, 'required release tool is not root-owned and protected');
  let cursor = dirname(resolved);
  while (true) {
    const parent = lstatSync(cursor);
    ensure(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 && (parent.mode & 0o022) === 0, 'required release tool path is not protected');
    if (cursor === '/') break;
    cursor = dirname(cursor);
  }
}
function assertTrustedRuntimeFile(path) {
  const resolved = realpathSync(path);
  const st = lstatSync(resolved);
  ensure(st.isFile() && st.uid === 0 && (st.mode & 0o022) === 0, 'required release runtime file is not root-owned and protected');
  let cursor = dirname(resolved);
  while (true) {
    const parent = lstatSync(cursor);
    ensure(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === 0 && (parent.mode & 0o022) === 0, 'required release runtime path is not protected');
    if (cursor === '/') break;
    cursor = dirname(cursor);
  }
}
function assertHostStagingToolchain() {
  assertTrustedExecutable(STAGING_NODE);
  assertTrustedRuntimeFile(STAGING_NPM_CLI);
  for (const tool of ['git', 'python3', 'shasum', 'tar', 'flock']) assertTrustedExecutable(`/usr/bin/${tool}`);
  const npmCheck = spawnSync(STAGING_NODE, [STAGING_NPM_CLI, '--version'], { encoding: 'utf8', env: { PATH: '/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin:/usr/bin:/bin' } });
  ensure(npmCheck.status === 0 && /^\d+\.\d+\.\d+\s*$/.test(npmCheck.stdout), 'protected npm CLI is incompatible with the protected Node runtime');
}
async function sha256File(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW })) digest.update(chunk);
  return digest.digest('hex');
}
function gitArchiveCommit(path) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', ['get-tar-commit-id'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise(output.trim()) : reject(new Error('candidate archive lacks Git commit metadata')));
    const input = createReadStream(path, { flags: constants.O_RDONLY | constants.O_NOFOLLOW });
    input.on('error', error => { child.kill(); reject(error); });
    input.pipe(child.stdin);
  });
}

const ARCHIVE_EXTRACT = String.raw`import base64, json, pathlib, sys, tarfile
archive, wanted = sys.argv[1], sys.argv[2:]
max_members, max_file, max_total = 250000, 2 * 1024 * 1024 * 1024, 4 * 1024 * 1024 * 1024
seen, total, selected = set(), 0, {}
with tarfile.open(archive, 'r:') as source:
    members = source.getmembers()
    if not members or len(members) > max_members: raise SystemExit('invalid candidate archive member count')
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or not member.name or '..' in path.parts or '\n' in member.name or '\r' in member.name:
            raise SystemExit('unsafe candidate archive member path')
        normalized = path.as_posix().rstrip('/')
        if not normalized or normalized in seen: raise SystemExit('duplicate candidate archive path')
        seen.add(normalized)
        if not (member.isdir() or member.isfile()): raise SystemExit('candidate archive contains a link or special file')
        if member.mode & 0o7000: raise SystemExit('candidate archive contains privileged mode bits')
        if member.isfile():
            if member.size > max_file: raise SystemExit('candidate archive member is too large')
            total += member.size
            if total > max_total: raise SystemExit('candidate archive expands beyond release limit')
    for name in wanted:
        matches = [member for member in members if member.name == name]
        if len(matches) != 1 or not matches[0].isfile(): raise SystemExit('required toolchain member is missing or not regular')
        content = source.extractfile(matches[0]).read()
        if not content.startswith(b'#!') or b'\0' in content: raise SystemExit('toolchain member is not a valid script')
        selected[name] = base64.b64encode(content).decode('ascii')
print(json.dumps(selected, separators=(',', ':')))`;

function extractPair(archivePath) {
  const result = spawnSync('python3', ['-c', ARCHIVE_EXTRACT, archivePath, STAGING, LOCK], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  ensure(result.status === 0, 'candidate archive toolchain extraction rejected');
  const selected = JSON.parse(result.stdout);
  return { stage: Buffer.from(selected[STAGING], 'base64'), lock: Buffer.from(selected[LOCK], 'base64') };
}
function verifyBootstrapSource(path, expectedSha) {
  ensure(/^[a-f0-9]{64}$/.test(expectedSha), 'bootstrap SHA-256 must be provided');
  assertProtectedFile(path, 0, 2 * 1024 * 1024);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try { bytes = readFileSync(fd); } finally { closeSync(fd); }
  ensure(hash(bytes) === expectedSha, 'bootstrap source checksum mismatch');
}
function mkdirPrivate(path) {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const st = lstatSync(path);
  ensure(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0, 'unsafe toolchain directory');
}
function atomicBytes(path, bytes, fileMode, replace = false) {
  const temporary = join(dirname(path), `.staging-control-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', fileMode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if (!replace) ensure(!existsSync(path), 'refusing to replace an existing toolchain file');
    renameSync(temporary, path);
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function atomicSymlink(linkPath, target) {
  const temporary = join(dirname(linkPath), `.current-${randomUUID()}`);
  symlinkSync(target, temporary);
  try {
    renameSync(temporary, linkPath);
    const parent = openSync(dirname(linkPath), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function verifyGeneration(generation, ownerUid) {
  assertDirectory(generation, ownerUid);
  const stagePath = join(generation, STAGING), lockPath = join(generation, LOCK);
  for (const path of [stagePath, lockPath]) {
    const st = lstatSync(path);
    ensure(st.isFile() && !st.isSymbolicLink() && st.uid === ownerUid && (st.mode & 0o022) === 0, 'toolchain generation contains unsafe file');
  }
  const manifest = JSON.parse(readFileSync(join(generation, 'toolchain-identity.json'), 'utf8'));
  ensure(hash(readFileSync(stagePath)) === manifest.staging_helper_sha256 && hash(readFileSync(lockPath)) === manifest.build_lock_sha256, 'toolchain generation checksum mismatch');
  const check = spawnSync('/bin/sh', ['-n', stagePath], { encoding: 'utf8' });
  ensure(check.status === 0, 'staging helper failed shell syntax validation');
  const checkLock = spawnSync('/bin/sh', ['-n', lockPath], { encoding: 'utf8' });
  ensure(checkLock.status === 0, 'build lock helper failed shell syntax validation');
  return manifest;
}

export async function installStagingToolchain({ archivePath, identityPath, controlRoot, ownerUid = process.getuid() }) {
  assertDirectory(controlRoot, ownerUid);
  if (ownerUid === 0) assertHostStagingToolchain();
  assertProtectedFile(archivePath, ownerUid, MAX_ARCHIVE_BYTES);
  assertProtectedFile(identityPath, ownerUid, 64 * 1024);
  const identity = parseCandidateIdentity(readFileSync(identityPath, 'utf8'));
  const snapshotPath = snapshotProtectedArchive(archivePath, controlRoot, ownerUid);
  try {
  const actualArchiveSha = await sha256File(snapshotPath);
  ensure(identity.source_sha256 === `sha256:${actualArchiveSha}`, 'candidate archive checksum does not match identity');
  ensure(await gitArchiveCommit(snapshotPath) === identity.git_sha, 'candidate archive commit does not match identity');
  const pair = extractPair(snapshotPath);
  const toolchainRoot = join(controlRoot, 'staging-toolchain');
  mkdirPrivate(toolchainRoot);
  const versions = join(toolchainRoot, 'versions');
  const history = join(toolchainRoot, 'history');
  mkdirPrivate(versions); mkdirPrivate(history);
  const generation = join(versions, identity.git_sha);
  if (!existsSync(generation)) {
    const preparing = join(versions, `.${identity.git_sha}.staging.${randomUUID()}`);
    mkdirPrivate(preparing);
    for (const sub of ['infra', 'infra/scripts']) mkdirPrivate(join(preparing, sub));
    atomicBytes(join(preparing, STAGING), pair.stage, 0o555);
    atomicBytes(join(preparing, LOCK), pair.lock, 0o444);
    const manifest = {
      schema_version: 'ecs-staging-toolchain/1', git_sha: identity.git_sha,
      source_archive_sha256: actualArchiveSha,
      staging_helper_sha256: hash(pair.stage), build_lock_sha256: hash(pair.lock),
      installed_at: new Date().toISOString(),
    };
    atomicBytes(join(preparing, 'toolchain-identity.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 0o400);
    syncDirectory(join(preparing, 'infra/scripts'));
    syncDirectory(join(preparing, 'infra'));
    syncDirectory(preparing);
    renameSync(preparing, generation);
    syncDirectory(versions);
  }
  const manifest = verifyGeneration(generation, ownerUid);
  ensure(manifest.git_sha === identity.git_sha && manifest.source_archive_sha256 === actualArchiveSha, 'existing generation is bound to a different candidate');

  const launcherPath = join(controlRoot, 'stage-verified-ecs-release.sh');
  const launcherBytes = Buffer.from(LAUNCHER);
  if (existsSync(launcherPath)) {
    const prior = lstatSync(launcherPath);
    ensure(prior.isFile() && !prior.isSymbolicLink() && prior.uid === ownerUid && (prior.mode & 0o022) === 0, 'existing staging entrypoint is unsafe');
    const oldBytes = readFileSync(launcherPath);
    if (!oldBytes.equals(launcherBytes)) {
      const archived = join(history, `pre-toolchain-launcher-${hash(oldBytes)}`);
      if (!existsSync(archived)) atomicBytes(archived, oldBytes, 0o400);
      else ensure(readFileSync(archived).equals(oldBytes), 'legacy staging backup mismatch');
    }
  }
  // Install the fixed dispatcher first. On first bootstrap, absence of current
  // makes it fail closed until the complete pair is switched into place.
  if (!existsSync(launcherPath) || !readFileSync(launcherPath).equals(launcherBytes)) atomicBytes(launcherPath, launcherBytes, 0o555, true);

  const currentPath = join(toolchainRoot, 'current');
  const previousPath = join(toolchainRoot, 'previous');
  if (existsSync(currentPath) || (() => { try { lstatSync(currentPath); return true; } catch { return false; } })()) {
    const currentStat = lstatSync(currentPath);
    ensure(currentStat.isSymbolicLink(), 'current toolchain pointer must be a symlink');
    const currentTarget = readlinkSyncSafe(currentPath);
    ensure(/^versions\/[a-f0-9]{40}$/.test(currentTarget), 'current toolchain pointer is invalid');
    const currentGeneration = join(toolchainRoot, currentTarget);
    verifyGeneration(currentGeneration, ownerUid);
    if (currentTarget !== `versions/${identity.git_sha}`) atomicSymlink(previousPath, currentTarget);
  }
  if (!existsSync(currentPath) || readlinkSyncSafe(currentPath) !== `versions/${identity.git_sha}`) atomicSymlink(currentPath, `versions/${identity.git_sha}`);
  const active = verifyGeneration(generation, ownerUid);
  const launcherCheck = spawnSync('/bin/sh', ['-n', launcherPath], { encoding: 'utf8' });
  ensure(launcherCheck.status === 0, 'dispatcher failed shell syntax validation');
  return { schema_version: 'ecs-staging-toolchain-install/1', git_sha: identity.git_sha, source_archive_sha256: actualArchiveSha, staging_helper_sha256: active.staging_helper_sha256, build_lock_sha256: active.build_lock_sha256, previous_git_sha: (() => { try { const target = readlinkSyncSafe(previousPath); return target.split('/')[1]; } catch { return null; } })() };
  } finally {
    unlinkSync(snapshotPath);
  }
}

function readlinkSyncSafe(path) {
  return readlinkSync(path);
}

export function rollbackStagingToolchain({ controlRoot, ownerUid = process.getuid() }) {
  assertDirectory(controlRoot, ownerUid);
  const toolchainRoot = join(controlRoot, 'staging-toolchain');
  assertDirectory(toolchainRoot, ownerUid);
  const currentPath = join(toolchainRoot, 'current'), previousPath = join(toolchainRoot, 'previous');
  const previousTarget = readlinkSyncSafe(previousPath);
  ensure(/^versions\/[a-f0-9]{40}$/.test(previousTarget), 'no previously verified staging toolchain is available for rollback');
  const generation = join(toolchainRoot, previousTarget);
  verifyGeneration(generation, ownerUid);
  const currentTarget = readlinkSyncSafe(currentPath);
  ensure(/^versions\/[a-f0-9]{40}$/.test(currentTarget), 'current toolchain pointer is invalid');
  atomicSymlink(currentPath, previousTarget);
  return { schema_version: 'ecs-staging-toolchain-rollback/1', from_git_sha: currentTarget.split('/')[1], to_git_sha: previousTarget.split('/')[1] };
}

function cli(args) {
  const action = args[0];
  ensure(process.getuid?.() === 0 && process.geteuid?.() === 0, 'staging toolchain installation requires root');
  ensure(!process.env.NODE_OPTIONS && !process.env.NODE_PATH, 'run with a clean Node environment');
  ensure(process.execPath === STAGING_NODE, 'staging toolchain installation requires the fixed protected Node runtime');
  ensure(process.versions.node === '22.23.2', 'staging toolchain installation requires Node 22.23.2');
  const script = fileURLToPath(import.meta.url);
  if (action === 'install') {
    ensure(args.length === 5, 'usage: install-ecs-staging-toolchain.mjs install <candidate-source.tar> <candidate-identity.txt> <control-root> <bootstrap-sha256>');
    const [, archivePath, identityPath, controlRoot, bootstrapSha] = args;
    verifyBootstrapSource(script, bootstrapSha);
    return runLocked(script, 'install', { archivePath, identityPath, controlRoot });
  }
  if (action === 'rollback') {
    ensure(args.length === 3, 'usage: install-ecs-staging-toolchain.mjs rollback <control-root> <bootstrap-sha256>');
    verifyBootstrapSource(script, args[2]);
    return runLocked(script, 'rollback', { controlRoot: args[1] });
  }
  throw new Error('expected install or rollback');
}
function runLocked(script, operation, options) {
  const lockPath = '/var/lib/merchant-release-security/locks/ecs-source-build.lock';
  const lockStat = lstatSync(lockPath);
  ensure(lockStat.isFile() && !lockStat.isSymbolicLink() && lockStat.uid === 0 && (lockStat.mode & 0o077) === 0, 'shared ECS source-build lock is not protected');
  const moduleUrl = pathToFileURL(script).href;
  const worker = operation === 'install'
    ? `import(${JSON.stringify(moduleUrl)}).then(async m=>console.log(JSON.stringify(await m.installStagingToolchain({...JSON.parse(process.argv[1]),ownerUid:0})))).catch(e=>{console.error(e?.message||'staging installation rejected');process.exit(1)})`
    : `import(${JSON.stringify(moduleUrl)}).then(m=>console.log(JSON.stringify(m.rollbackStagingToolchain({...JSON.parse(process.argv[1]),ownerUid:0})))).catch(e=>{console.error(e?.message||'staging rollback rejected');process.exit(1)})`;
  const result = spawnSync('/usr/bin/flock', ['-n', lockPath, process.execPath, '--input-type=module', '-e', worker, JSON.stringify(options)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'another staging/build operation holds the shared lock');
  return JSON.parse(result.stdout.trim());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = error => { console.error(`ECS staging toolchain operation rejected: ${error?.message || 'unknown error'}; no deployment was performed`); process.exitCode = 1; };
  try { Promise.resolve(cli(process.argv.slice(2))).then(receipt => console.log(JSON.stringify(receipt))).catch(report); }
  catch (error) { report(error); }
}
