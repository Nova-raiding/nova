import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

type Capture = { release_id?: string; observed_at?: string; http_status?: number; provider_request_id?: string; relay?: string; endpoint?: string }
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value))
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

export function buildRelayRecoveryEvidence(failure: Capture, recovery: Capture, releaseId: string) {
  if (!/^[A-Za-z0-9._-]+$/u.test(releaseId)) throw new Error('release id is unsafe')
  if (failure.release_id !== releaseId || recovery.release_id !== releaseId) throw new Error('both captures must match the requested release')
  if (failure.http_status !== 503) throw new Error('failure capture must have HTTP 503')
  if (!Number.isSafeInteger(recovery.http_status) || recovery.http_status! < 200 || recovery.http_status! > 299) throw new Error('recovery capture must have HTTP 2xx')
  if (!iso(failure.observed_at) || !iso(recovery.observed_at) || Date.parse(recovery.observed_at) <= Date.parse(failure.observed_at)) throw new Error('recovery must be observed after the 503 failure')
  if (!text(failure.provider_request_id) || !text(recovery.provider_request_id) || failure.provider_request_id === recovery.provider_request_id) throw new Error('captures must have distinct provider request ids')
  if (!text(failure.relay) || failure.relay !== recovery.relay || !text(failure.endpoint) || failure.endpoint !== recovery.endpoint) throw new Error('captures must use the same relay and endpoint')
  return {
    verified: true,
    failure_status: 503,
    failure_observed_at: failure.observed_at,
    recovered_at: recovery.observed_at,
    failed_request_id: failure.provider_request_id,
    recovery_request_id: recovery.provider_request_id,
  }
}

function argument(name: string) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined }
export function main() {
  const failurePath = argument('--failure'); const recoveryPath = argument('--recovery'); const outputPath = argument('--output')
  const artifactRoot = argument('--artifact-root'); const releaseId = argument('--release-id')
  if (!failurePath || !recoveryPath || !outputPath || !artifactRoot || !releaseId) throw new Error('--failure, --recovery, --output, --artifact-root and --release-id are required')
  const root = realpathSync(artifactRoot)
  for (const path of [failurePath, recoveryPath]) {
    const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('capture inputs must be regular non-symlink files')
  }
  const failure = JSON.parse(readFileSync(failurePath, 'utf8')) as Capture
  const recovery = JSON.parse(readFileSync(recoveryPath, 'utf8')) as Capture
  const summary = buildRelayRecoveryEvidence(failure, recovery, releaseId)
  const artifactBody = `${JSON.stringify({ schema_version: '1', release_id: releaseId, failure, recovery }, null, 2)}\n`
  const artifactDirectory = resolve(root, 'relay', releaseId)
  if (artifactDirectory !== root && !artifactDirectory.startsWith(`${root}${sep}`)) throw new Error('artifact path escapes root')
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 })
  const digest = createHash('sha256').update(artifactBody).digest('hex')
  const artifactPath = resolve(artifactDirectory, `error-recovery-${digest.slice(0, 16)}.json`)
  writeFileSync(artifactPath, artifactBody, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  const evidenceRef = `artifact://production/${relative(root, artifactPath).split('\\').join('/')}#${digest}`
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 })
  writeFileSync(outputPath, `${JSON.stringify({ ...summary, evidence_ref: evidenceRef }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  console.log(`relay recovery evidence prepared from existing captures: ${outputPath}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main() } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
