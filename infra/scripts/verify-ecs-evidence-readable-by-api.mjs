import { lstatSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const API_UID = 10001
const API_GID = 10001

export function canReadEvidenceAsApi({ uid, gid, mode }) {
  const permissions = mode & 0o777
  if (uid === API_UID) return (permissions & 0o400) !== 0 && (permissions & 0o200) === 0
  if (gid === API_GID) return (permissions & 0o040) !== 0 && (permissions & 0o020) === 0
  return (permissions & 0o004) !== 0 && (permissions & 0o002) === 0
}

export function verifyEvidenceReadableByApi(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error('EVIDENCE_PATH_MUST_BE_CANONICAL_ABSOLUTE')
  }
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('EVIDENCE_MUST_BE_REGULAR_FILE')
  if (metadata.size <= 0) throw new Error('EVIDENCE_MUST_NOT_BE_EMPTY')
  if (!canReadEvidenceAsApi({ uid: metadata.uid, gid: metadata.gid, mode: metadata.mode })) {
    throw new Error('EVIDENCE_NOT_READABLE_BY_API_UID_10001_GID_10001')
  }
  return { readable: true, bytes: metadata.size }
}

function main(paths) {
  if (paths.length !== 2) throw new Error('CAPABILITY_AND_CAPACITY_EVIDENCE_PATHS_REQUIRED')
  for (const path of paths) verifyEvidenceReadableByApi(path)
  process.stdout.write('ECS release evidence is readable by API UID/GID 10001\n')
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try { main(process.argv.slice(2)) }
  catch (error) {
    process.stderr.write(`ECS_EVIDENCE_API_READABILITY_BLOCKED: ${error instanceof Error ? error.message : 'UNKNOWN'}\n`)
    process.exitCode = 1
  }
}
