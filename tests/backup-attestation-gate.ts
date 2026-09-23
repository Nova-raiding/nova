import { createHash, createPublicKey, verify } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { basename } from 'node:path'

const compare = ([a]: [string, unknown], [b]: [string, unknown]) => a < b ? -1 : a > b ? 1 : 0
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(compare).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
function hashBackupFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size <= 0) throw new Error('backup must be a nonempty regular file')
    const digest = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024)
    let total = 0, count: number
    while ((count = readSync(fd, chunk, 0, chunk.length, null)) > 0) { digest.update(chunk.subarray(0, count)); total += count }
    if (total !== stat.size) throw new Error('backup changed while hashing')
    return digest.digest('hex')
  } finally { closeSync(fd) }
}
export function validateBackupAttestation(document: unknown, options: { backupPath: string; expectedBackupFileName?: string; trustedKeyId: string; publicKeyPem: string; expectedSourceDatabaseIdSha256: string; requireSnapshotTime?: boolean; now?: Date }): string[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as Record<string, unknown>; const errors: string[] = []
  const schema = value.schema_version
  if (schema !== '1' && schema !== '2') errors.push('schema_version must be 1 or 2')
  if (options.requireSnapshotTime && schema !== '2') errors.push('strict restore requires a v2 backup with signed snapshot time')
  const expected = { kind: 'postgres_backup', environment: 'production', key_id: options.trustedKeyId, backup_file_name: options.expectedBackupFileName ?? basename(options.backupPath) }
  for (const [field, wanted] of Object.entries(expected)) if (value[field] !== wanted) errors.push(`${field} must match ${wanted}`)
  if (value.simulated !== false) errors.push('simulated must be false')
  try {
    const real = realpathSync(options.backupPath); const stat = lstatSync(options.backupPath)
    if (!stat.isFile() || stat.isSymbolicLink() || real !== options.backupPath) errors.push('backup must be a canonical regular non-symlink file')
    const actual = hashBackupFile(real)
    if (value.backup_sha256 !== actual) errors.push('backup_sha256 does not match backup bytes')
  } catch { errors.push('backup cannot be read') }
  if (!/^[a-f0-9]{64}$/u.test(String(value.source_database_id_sha256 ?? ''))) errors.push('source_database_id_sha256 must be a privacy-safe SHA-256 identifier')
  else if (value.source_database_id_sha256 !== options.expectedSourceDatabaseIdSha256) errors.push('source_database_id_sha256 does not match the approved source database')
  const created = Date.parse(String(value.created_at ?? '')); const expires = Date.parse(String(value.expires_at ?? '')); const now = (options.now ?? new Date()).getTime()
  if (!Number.isFinite(created) || created > now + 300_000) errors.push('created_at is invalid')
  if (!Number.isFinite(expires) || expires <= now) errors.push('backup attestation has expired')
  if (schema === '2') {
    const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
    const timestamps = ['backup_started_at', 'snapshot_export_observed_at', 'dump_completed_at'] as const
    for (const field of timestamps) if (typeof value[field] !== 'string' || !utc.test(value[field]) || !Number.isFinite(Date.parse(value[field]))) errors.push(`${field} must be a strict UTC timestamp`)
    const started = Date.parse(String(value.backup_started_at ?? ''))
    const snapshot = Date.parse(String(value.snapshot_export_observed_at ?? ''))
    const completed = Date.parse(String(value.dump_completed_at ?? ''))
    if (Number.isFinite(started) && created !== started) errors.push('created_at must equal backup_started_at')
    if (Number.isFinite(started) && Number.isFinite(snapshot) && snapshot < started) errors.push('snapshot observation predates backup start')
    if (Number.isFinite(snapshot) && Number.isFinite(completed) && completed < snapshot) errors.push('dump completed before snapshot observation')
    if (Number.isFinite(completed) && completed > now + 300_000) errors.push('dump completion must not be in the future')
    if (Number.isFinite(completed) && Number.isFinite(expires) && (expires <= completed || expires > completed + 24 * 60 * 60_000)) errors.push('backup attestation validity exceeds the protected maximum')
    if (!/^[a-f0-9]{64}$/u.test(String(value.snapshot_id_sha256 ?? ''))) errors.push('snapshot_id_sha256 must be a SHA-256 hash')
  }
  const signature = value.signature_base64
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) errors.push('signature_base64 must be a canonical Ed25519 signature')
  else try { const key = createPublicKey(options.publicKeyPem); if (key.asymmetricKeyType !== 'ed25519') errors.push('trusted public key must be Ed25519'); else if (!verify(null, Buffer.from(canonical(value)), key, Buffer.from(signature, 'base64'))) errors.push('signature_base64 is invalid') } catch { errors.push('trusted public key or signature is invalid') }
  return errors
}
function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function main() {
  const file = arg('--file'); const backup = arg('--backup'); const publicKey = arg('--public-key'); const keyId = arg('--key-id'); const expectedSource = arg('--expected-source-database-id-sha256'); const expectedBackupFileName = arg('--expected-backup-file-name'); const requireSnapshotTime = process.argv.includes('--require-snapshot-time')
  if (!file || !backup || !publicKey || !keyId || !expectedSource) { console.error('signed backup attestation, backup, source database identity and fixed trust anchor are required'); process.exit(2) }
  const errors = validateBackupAttestation(JSON.parse(readFileSync(file, 'utf8')), { backupPath: realpathSync(backup), ...(expectedBackupFileName ? { expectedBackupFileName } : {}), publicKeyPem: readFileSync(publicKey, 'utf8'), trustedKeyId: keyId, expectedSourceDatabaseIdSha256: expectedSource, requireSnapshotTime })
  if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
  console.log(`signed backup attestation passed: ${basename(backup)}`)
}
if (import.meta.url === `file://${process.argv[1]}`) main()
