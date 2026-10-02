#!/usr/bin/env node
/**
 * Install a signed/validated production evidence document at the read-only
 * path mounted into the ECS API containers.
 *
 * The evidence producer keeps its immutable artifact root-only (0600). This
 * host-root handoff creates a byte-for-byte copy owned by root:10001 with
 * mode 0640 so the unprivileged API can read it. It never edits or replaces
 * the source artifact and it refuses to replace an existing runtime file.
 */
import {
  closeSync,
  constants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
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
export const RUNTIME_EVIDENCE_TARGETS = Object.freeze({
  capability: '/run/release-evidence/platform-capability.json',
  capacity: '/run/release-evidence/capacity-report.json',
})
const SOURCE_MODE = 0o600
const RUNTIME_MODE = 0o640
const MAX_BYTES = 4 * 1024 * 1024

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
  assert(Object.hasOwn(RUNTIME_EVIDENCE_TARGETS, kind), 'kind must be capability or capacity')
  assert(targetPath === RUNTIME_EVIDENCE_TARGETS[kind], 'target must be the fixed ECS runtime evidence path')
  assert(typeof targetPath === 'string' && targetPath.startsWith('/') && resolve(targetPath) === targetPath, 'target must be a canonical absolute path')
  return targetPath
}

function validateTarget(kind, targetPath) {
  validateRuntimeTarget(kind, targetPath)
  const parent = dirname(targetPath)
  protectedDirectory(parent, 'target parent')
  assert(basename(targetPath) === basename(RUNTIME_EVIDENCE_TARGETS[kind]), 'target filename does not match kind')
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
      'runtime evidence must be root-owned:g10001 mode 0640')
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

export function installRuntimeEvidence({ kind, sourcePath, targetPath = RUNTIME_EVIDENCE_TARGETS[kind] }) {
  assert(process.getuid?.() === 0 && process.geteuid?.() === 0, 'runtime evidence handoff requires host root')
  const source = readSource(sourcePath)
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
