#!/usr/bin/env node
/**
 * Install a signed/validated production evidence document at the read-only
 * path mounted into the ECS API containers.
 *
 * The evidence producer keeps its immutable artifact root-only (0600). This
 * host-root handoff creates a byte-for-byte copy owned by root:10001 with
 * mode 0440 so the unprivileged API can read it. It never edits or replaces
 * the source artifact and it refuses to replace an existing runtime file.
 */
import {
  closeSync,
  constants,
  chmodSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const API_UID = 10001
export const API_GID = 10001
// Keep the host source persistent across reboots. Compose still mounts each
// file into the fixed container paths under /run/release-evidence/.
export const RUNTIME_EVIDENCE_TARGET_ROOT = '/var/lib/merchant-release-security/runtime-evidence'
export const RUNTIME_EVIDENCE_TARGET_NAMES = Object.freeze({
  capability: 'platform-capability.json',
  capacity: 'capacity-report.json',
})
const RELEASE_ID_PATTERN = /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const SOURCE_MODE = 0o600
const RUNTIME_MODE = 0o440
const MAX_BYTES = 4 * 1024 * 1024

/** Validate the handoff payload before creating the API-readable copy.  A
 * missing source file causes Docker to create a directory at the bind target,
 * while an old `{}` placeholder is technically a regular file but still makes
 * the runtime claim that evidence is present.  Reject both cases at the
 * immutable handoff boundary and bind the document to the release directory.
 */
export function validateEvidenceDocument(kind, bytes, targetPath) {
  assert(Object.hasOwn(RUNTIME_EVIDENCE_TARGET_NAMES, kind), 'kind must be capability or capacity')
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('source must contain valid JSON evidence') }
  assert(value && typeof value === 'object' && !Array.isArray(value), 'source evidence must be a JSON object')
  const releaseId = targetPath.slice(`${RUNTIME_EVIDENCE_TARGET_ROOT}/`.length).split('/')[0]
  assert(value.release_id === releaseId, 'source evidence release_id must match runtime target release')
  if (kind === 'capacity') {
    assert(value.schema_version === '1', 'capacity source schema_version must be 1')
    assert(typeof value.profile === 'string' && value.profile.trim(), 'capacity source profile is required')
  } else {
    assert(['1', 'manual-operations-evidence/2'].includes(value.schema_version), 'capability source schema_version is unsupported')
  }
  assert(value.status !== 'placeholder' && value.status !== 'example', 'source evidence must not be a placeholder or example')
  return value
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function canonicalAbsolute(path, label) {
  assert(typeof path === 'string' && path.startsWith('/') && resolve(path) === path, `${label} must be a canonical absolute path`)
  assert(realpathSync(path) === path, `${label} must contain no symlink components`)
}

function protectedDirectory(path, label) {
  canonicalAbsolute(path, label)
  const metadata = lstatSync(path)
  assert(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} must be a regular directory`)
  assert(metadata.uid === 0 && (metadata.mode & 0o022) === 0, `${label} must be root-owned and not group/other writable`)
}

export function validateRuntimeEvidenceDirectoryMetadata(metadata) {
  assert(metadata && metadata.isDirectory() && !metadata.isSymbolicLink()
    && metadata.uid === 0 && (metadata.mode & 0o777) === 0o700,
  'runtime evidence root must be root-owned mode 0700')
}

function readSource(sourcePath) {
  canonicalAbsolute(sourcePath, 'source')
  protectedDirectory(dirname(sourcePath), 'source parent')
  const metadata = lstatSync(sourcePath)
  assert(metadata.isFile() && !metadata.isSymbolicLink(), 'source must be a regular file')
  assert(metadata.uid === 0 && (metadata.mode & 0o777) === SOURCE_MODE, 'source must be root-owned mode 0600')
  assert(metadata.size > 0 && metadata.size <= MAX_BYTES, 'source size is outside the evidence limit')

  const fd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    assert(before.isFile() && before.uid === 0 && (before.mode & 0o777) === SOURCE_MODE, 'source changed before read')
    assert(before.size > 0 && before.size <= MAX_BYTES, 'source size changed before read')
    const bytes = Buffer.allocUnsafe(Number(before.size))
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      assert(count > 0, 'source ended before its declared size')
      offset += count
    }
    const after = fstatSync(fd)
    assert(after.dev === before.dev && after.ino === before.ino && after.size === before.size
      && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs, 'source changed during read')
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  } finally {
    closeSync(fd)
  }
}

export function validateRuntimeTarget(kind, targetPath) {
  assert(Object.hasOwn(RUNTIME_EVIDENCE_TARGET_NAMES, kind), 'kind must be capability or capacity')
  assert(typeof targetPath === 'string' && targetPath.startsWith('/') && resolve(targetPath) === targetPath, 'target must be a canonical absolute path')
  const prefix = `${RUNTIME_EVIDENCE_TARGET_ROOT}/`
  assert(targetPath.startsWith(prefix), 'target must be under the ECS runtime evidence root')
  const parts = targetPath.slice(prefix.length).split('/')
  assert(parts.length === 2 && RELEASE_ID_PATTERN.test(parts[0]), 'target must use a release-scoped runtime evidence directory')
  assert(parts[1] === RUNTIME_EVIDENCE_TARGET_NAMES[kind], 'target filename does not match kind')
  return targetPath
}

function validateTarget(kind, targetPath) {
  validateRuntimeTarget(kind, targetPath)
  const parent = dirname(targetPath)
  const rootParent = dirname(RUNTIME_EVIDENCE_TARGET_ROOT)
  protectedDirectory(rootParent, 'runtime evidence root parent')
  try {
    const metadata = lstatSync(RUNTIME_EVIDENCE_TARGET_ROOT)
    validateRuntimeEvidenceDirectoryMetadata(metadata)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    mkdirSync(RUNTIME_EVIDENCE_TARGET_ROOT, { mode: 0o700 })
    chmodSync(RUNTIME_EVIDENCE_TARGET_ROOT, 0o700)
  }
  validateRuntimeEvidenceDirectoryMetadata(lstatSync(RUNTIME_EVIDENCE_TARGET_ROOT))
  try {
    const metadata = lstatSync(parent)
    assert(metadata.isDirectory() && !metadata.isSymbolicLink(), 'target parent must be a regular directory')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    mkdirSync(parent, { mode: 0o700 })
    chmodSync(parent, 0o700)
  }
  const metadata = lstatSync(parent)
  assert(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === 0 && (metadata.mode & 0o777) === 0o700,
    'target parent must be root-owned mode 0700')
  try {
    const existing = lstatSync(targetPath)
    assert(!existing.isSymbolicLink(), 'target already exists as a symlink')
    throw new Error('target already exists; runtime evidence is append-only')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return parent
}

function verifyRuntimeFile(path, expectedSha256) {
  canonicalAbsolute(path, 'runtime evidence')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(fd)
    assert(metadata.isFile() && metadata.uid === 0 && metadata.gid === API_GID && (metadata.mode & 0o777) === RUNTIME_MODE,
      'runtime evidence must be root-owned:g10001 mode 0440')
    const bytes = Buffer.allocUnsafe(Number(metadata.size))
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      assert(count > 0, 'runtime evidence ended before its declared size')
      offset += count
    }
    assert(createHash('sha256').update(bytes).digest('hex') === expectedSha256, 'runtime evidence hash differs from source')
    return { bytes: bytes.length, sha256: expectedSha256 }
  } finally {
    closeSync(fd)
  }
}

export function installRuntimeEvidence({ kind, sourcePath, targetPath }) {
  assert(process.getuid?.() === 0 && process.geteuid?.() === 0, 'runtime evidence handoff requires host root')
  const source = readSource(sourcePath)
  validateEvidenceDocument(kind, source.bytes, targetPath)
  const parent = validateTarget(kind, targetPath)
  assert(resolve(sourcePath) !== resolve(targetPath), 'source and target must differ')
  const tempPath = resolve(parent, `.${basename(targetPath)}.${process.pid}.tmp`)
  let linked = false
  try {
    const fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      let offset = 0
      while (offset < source.bytes.length) offset += writeSync(fd, source.bytes, offset, source.bytes.length - offset)
      fsyncSync(fd)
      fchownSync(fd, 0, API_GID)
      fchmodSync(fd, RUNTIME_MODE)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    linkSync(tempPath, targetPath)
    linked = true
    const result = verifyRuntimeFile(targetPath, source.sha256)
    return { kind, source: sourcePath, target: targetPath, ...result }
  } catch (error) {
    if (linked) {
      try { unlinkSync(targetPath) } catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') throw cleanupError }
    }
    throw error
  } finally {
    try { unlinkSync(tempPath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}

function option(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function main(args) {
  assert(args[0] === 'install', 'install subcommand required')
  const kind = option(args, '--kind')
  const sourcePath = option(args, '--source')
  const targetPath = option(args, '--target')
  assert(kind && sourcePath && targetPath && args.length === 7, 'usage: install --kind capability|capacity --source ABS --target ABS')
  const result = installRuntimeEvidence({ kind, sourcePath, targetPath })
  process.stdout.write(`runtime evidence installed: kind=${result.kind} bytes=${result.bytes} sha256=${result.sha256}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)) }
  catch (error) { process.stderr.write(`runtime evidence handoff rejected: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 }
}
