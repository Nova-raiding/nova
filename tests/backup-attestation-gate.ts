import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename } from 'node:path'

const compare = ([a]: [string, unknown], [b]: [string, unknown]) => a < b ? -1 : a > b ? 1 : 0
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(compare).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export function validateBackupAttestation(document: unknown, options: { backupPath: string; expectedBackupFileName?: string; trustedKeyId: string; publicKeyPem: string; expectedSourceDatabaseIdSha256: string; now?: Date }): string[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as Record<string, unknown>; const errors: string[] = []
  const expected = { schema_version: '1', kind: 'postgres_backup', environment: 'production', key_id: options.trustedKeyId, backup_file_name: options.expectedBackupFileName ?? basename(options.backupPath) }
  for (const [field, wanted] of Object.entries(expected)) if (value[field] !== wanted) errors.push(`${field} must match ${wanted}`)
  if (value.simulated !== false) errors.push('simulated must be false')
  try {
    const real = realpathSync(options.backupPath); const stat = lstatSync(options.backupPath)
    if (!stat.isFile() || stat.isSymbolicLink() || real !== options.backupPath) errors.push('backup must be a canonical regular non-symlink file')
    const actual = createHash('sha256').update(readFileSync(real)).digest('hex')
    if (value.backup_sha256 !== actual) errors.push('backup_sha256 does not match backup bytes')
  } catch { errors.push('backup cannot be read') }
  if (!/^[a-f0-9]{64}$/u.test(String(value.source_database_id_sha256 ?? ''))) errors.push('source_database_id_sha256 must be a privacy-safe SHA-256 identifier')
  else if (value.source_database_id_sha256 !== options.expectedSourceDatabaseIdSha256) errors.push('source_database_id_sha256 does not match the approved source database')
  const created = Date.parse(String(value.created_at ?? '')); const expires = Date.parse(String(value.expires_at ?? '')); const now = (options.now ?? new Date()).getTime()
  if (!Number.isFinite(created) || created > now + 300_000) errors.push('created_at is invalid')
  if (!Number.isFinite(expires) || expires <= now) errors.push('backup attestation has expired')
  const signature = value.signature_base64
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) errors.push('signature_base64 must be a canonical Ed25519 signature')
  else try { const key = createPublicKey(options.publicKeyPem); if (key.asymmetricKeyType !== 'ed25519') errors.push('trusted public key must be Ed25519'); else if (!verify(null, Buffer.from(canonical(value)), key, Buffer.from(signature, 'base64'))) errors.push('signature_base64 is invalid') } catch { errors.push('trusted public key or signature is invalid') }
  return errors
}
function arg(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
function main() {
  const file = arg('--file'); const backup = arg('--backup'); const publicKey = arg('--public-key'); const keyId = arg('--key-id'); const expectedSource = arg('--expected-source-database-id-sha256'); const expectedBackupFileName = arg('--expected-backup-file-name')
  if (!file || !backup || !publicKey || !keyId || !expectedSource) { console.error('signed backup attestation, backup, source database identity and fixed trust anchor are required'); process.exit(2) }
  const errors = validateBackupAttestation(JSON.parse(readFileSync(file, 'utf8')), { backupPath: realpathSync(backup), ...(expectedBackupFileName ? { expectedBackupFileName } : {}), publicKeyPem: readFileSync(publicKey, 'utf8'), trustedKeyId: keyId, expectedSourceDatabaseIdSha256: expectedSource })
  if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
  console.log(`signed backup attestation passed: ${basename(backup)}`)
}
if (import.meta.url === `file://${process.argv[1]}`) main()
