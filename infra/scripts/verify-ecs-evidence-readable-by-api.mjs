import { lstatSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'

const API_UID = 10001
const API_GID = 10001
export const RUNTIME_EVIDENCE_HOST_ROOT = '/var/lib/merchant-release-security/runtime-evidence'
const RUNTIME_EVIDENCE_NAMES = Object.freeze({ capability: 'platform-capability.json', capacity: 'capacity-report.json' })
const RELEASE_ID_PATTERN = /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u

export function canReadEvidenceAsApi({ uid, gid, mode }) {
  const permissions = mode & 0o777
  if ((permissions & 0o222) !== 0) return false
  if (uid === API_UID) return (permissions & 0o400) !== 0
  if (gid === API_GID) return (permissions & 0o040) !== 0
  return (permissions & 0o004) !== 0
}

export function hasRuntimeEvidenceMetadata({ uid, gid, mode }) {
  return uid === 0 && gid === API_GID && (mode & 0o777) === 0o440
}

export function verifyEvidenceReadableByApi(path, options = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error('EVIDENCE_PATH_MUST_BE_CANONICAL_ABSOLUTE')
  }
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('EVIDENCE_MUST_BE_REGULAR_FILE')
  if (metadata.size <= 0) throw new Error('EVIDENCE_MUST_NOT_BE_EMPTY')
  if (options.runtimeMetadata === true && !hasRuntimeEvidenceMetadata(metadata)) {
    throw new Error('RUNTIME_EVIDENCE_METADATA_INVALID')
  }
  if (!canReadEvidenceAsApi({ uid: metadata.uid, gid: metadata.gid, mode: metadata.mode })) {
    throw new Error('EVIDENCE_NOT_READABLE_BY_API_UID_10001_GID_10001')
  }
  return { readable: true, bytes: metadata.size }
}

export function verifyRuntimeEvidencePath(path, kind, releaseId) {
  if (!Object.hasOwn(RUNTIME_EVIDENCE_NAMES, kind) || !RELEASE_ID_PATTERN.test(releaseId ?? '')) {
    throw new Error('RUNTIME_EVIDENCE_RELEASE_BINDING_INVALID')
  }
  const expected = `${RUNTIME_EVIDENCE_HOST_ROOT}/${releaseId}/${RUNTIME_EVIDENCE_NAMES[kind]}`
  if (path !== expected || basename(path) !== RUNTIME_EVIDENCE_NAMES[kind]) {
    throw new Error('RUNTIME_EVIDENCE_PATH_RELEASE_BINDING_INVALID')
  }
  const rootParent = resolve(RUNTIME_EVIDENCE_HOST_ROOT, '..')
  for (const [directory, mode] of [[rootParent, 0o700], [RUNTIME_EVIDENCE_HOST_ROOT, 0o700], [resolve(RUNTIME_EVIDENCE_HOST_ROOT, releaseId), 0o700]]) {
    if (realpathSync(directory) !== directory) throw new Error('RUNTIME_EVIDENCE_DIRECTORY_NOT_CANONICAL')
    const metadata = lstatSync(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || (metadata.mode & 0o777) !== mode) {
      throw new Error('RUNTIME_EVIDENCE_DIRECTORY_METADATA_INVALID')
    }
  }
  return verifyEvidenceReadableByApi(path, { runtimeMetadata: true })
}

function main(args) {
  if (args.length !== 2 && args.length !== 4 || (args.length === 4 && args[2] !== '--release-id')) {
    throw new Error('CAPABILITY_AND_CAPACITY_EVIDENCE_PATHS_REQUIRED')
  }
  if (args.length === 2) {
    for (const path of args) verifyEvidenceReadableByApi(path)
  } else {
    const releaseId = args[3]
    verifyRuntimeEvidencePath(args[0], 'capability', releaseId)
    verifyRuntimeEvidencePath(args[1], 'capacity', releaseId)
  }
  process.stdout.write('ECS release evidence permission metadata allows read-only access for API UID/GID 10001\n')
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try { main(process.argv.slice(2)) }
  catch (error) {
    process.stderr.write(`ECS_EVIDENCE_API_READABILITY_BLOCKED: ${error instanceof Error ? error.message : 'UNKNOWN'}\n`)
    process.exitCode = 1
  }
}
