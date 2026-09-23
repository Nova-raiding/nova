import { createHash, createPublicKey } from 'node:crypto'
import { lstat as lstatFile, readFile as readTextFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool, type PoolClient } from 'pg'
import {
  assetScanReceiptDigest,
  parseAssetScanReceipt,
  verifyAssetScanReceiptSignature,
} from '../packages/security/src/asset-scan-receipt.js'

type EvidenceInput = {
  workspaceId: string
  assetId: string
  sha256: string
  trustedKeyId: string
}

type EvidenceRow = {
  event_id: string
  event_type: string
  workspace_id: string
  aggregate_id: string
  event_payload: Record<string, unknown>
  event_created_at: Date | string
  event_published_at: Date | string | null
  event_unknown_at: Date | string | null
  event_unleased: boolean
  entity_version: number | string
  asset: Record<string, unknown>
  asset_source_revision: number
  outbox_event_id: string
  callback_status: string
  callback_attempts: number
  callback_accepted_at: Date | string | null
  canonical_receipt: string
  attempt_receipt_id: string
  attempt_digest: string
  attempt_signature: string
  receipt_id: string
  receipt_digest: string
  canonical_payload: string
  receipt: unknown
  attempt_receipt: unknown
  callback_body: string
  receipt_signature: string
  verdict: string
  object_key: string
  object_sha256: string
}

export type ScannerCanaryProofSummary = {
  status: 'passed'
  releaseProof: false
  workspaceId: string
  assetId: string
  sha256: string
  eventId: string
  sourceRevision: number
  callbackAcceptedAt: string
  receiptId: string
  receiptDigest: string
  keyId: string
  signatureVerified: true
  scanStatus: 'clean'
  database: { role: 'merchant_app'; readOnly: true; rlsGuarded: true }
}

function prove(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`SCANNER_CANARY_EVIDENCE_${code}`)
}

function timestamp(value: Date | string | null): number | null {
  if (value == null) return null
  const parsed = value instanceof Date ? value.valueOf() : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, normalize(nested)]))
      : item
  return JSON.stringify(normalize(value))
}

/** Pure proof-binding validator. Never returns receipt bodies or signatures. */
export function verifyScannerCanaryEvidence(input: EvidenceInput, row: EvidenceRow, trustedPublicKeyPem: string): ScannerCanaryProofSummary {
  prove(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.workspaceId), 'WORKSPACE_ID_INVALID')
  prove(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.assetId), 'ASSET_ID_INVALID')
  prove(/^[a-f0-9]{64}$/u.test(input.sha256), 'SHA256_INVALID')
  prove(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.trustedKeyId), 'KEY_ID_INVALID')
  prove(row.event_type === 'asset.uploaded' && row.workspace_id === input.workspaceId && row.aggregate_id === input.assetId, 'EVENT_BINDING_MISMATCH')
  prove(row.event_id === row.outbox_event_id && row.event_payload.asset_id === input.assetId
    && row.event_payload.sha256 === input.sha256, 'EVENT_PAYLOAD_MISMATCH')
  prove(row.event_unknown_at == null && row.event_published_at != null && row.event_unleased, 'EVENT_NOT_COMPLETED')
  prove(row.callback_status === 'accepted' && Number.isSafeInteger(row.callback_attempts) && row.callback_attempts > 0, 'CALLBACK_NOT_ACCEPTED')
  prove(Number.isSafeInteger(row.asset_source_revision) && row.asset_source_revision > 0, 'SOURCE_REVISION_INVALID')
  const eventRevision = row.event_payload.source_revision
  const snapshotRevision = row.asset.sourceRevision
  const declaredRevision = eventRevision ?? snapshotRevision ?? 1
  prove(Number(declaredRevision) === row.asset_source_revision, 'SOURCE_REVISION_MISMATCH')

  const createdAt = timestamp(row.event_created_at)
  const publishedAt = timestamp(row.event_published_at)
  const acceptedAt = timestamp(row.callback_accepted_at)
  prove(createdAt !== null && publishedAt !== null && acceptedAt !== null
    && publishedAt >= createdAt && acceptedAt >= publishedAt, 'CALLBACK_CHRONOLOGY_INVALID')

  let receipt: ReturnType<typeof parseAssetScanReceipt>
  try {
    const decoded = JSON.parse(row.canonical_payload) as unknown
    receipt = parseAssetScanReceipt(decoded, { now: new Date((decoded as { issued_at?: string }).issued_at ?? '') })
    prove(JSON.stringify(receipt) === row.canonical_payload && row.canonical_receipt === row.canonical_payload, 'CANONICAL_RECEIPT_MISMATCH')
    prove(stableJson(row.receipt) === stableJson(decoded) && stableJson(row.attempt_receipt) === stableJson(decoded), 'PERSISTED_RECEIPT_MISMATCH')
    const callbackBody = JSON.parse(row.callback_body) as { receipt?: unknown; signature?: unknown }
    prove(stableJson(callbackBody.receipt) === stableJson(decoded) && callbackBody.signature === row.attempt_signature, 'CALLBACK_BODY_MISMATCH')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('SCANNER_CANARY_EVIDENCE_')) throw error
    throw new Error('SCANNER_CANARY_EVIDENCE_RECEIPT_INVALID')
  }
  const digest = assetScanReceiptDigest(receipt)
  prove(row.receipt_id === receipt.receipt_id && row.attempt_receipt_id === receipt.receipt_id
    && row.receipt_digest === digest && row.attempt_digest === digest, 'RECEIPT_DIGEST_MISMATCH')
  prove(row.verdict === 'clean' && receipt.scan.verdict === 'clean' && receipt.scan.engine === 'clamav', 'SCAN_NOT_CLEAN')
  prove(receipt.scan_job_id === row.event_id
    && receipt.scan_attempt_id === `attempt_${sha256(`${row.event_id}\0${row.asset_source_revision}`)}`
    && receipt.receipt_id === `scan_${sha256(`${row.event_id}\0${row.asset_source_revision}\0${input.sha256}`)}`, 'SCAN_EVENT_MISMATCH')
  prove(receipt.issuer.key_id === input.trustedKeyId, 'TRUSTED_KEY_ID_MISMATCH')
  prove(receipt.subject.workspace_id === input.workspaceId && receipt.subject.asset_id === input.assetId
    && receipt.subject.asset_source_revision === row.asset_source_revision && receipt.subject.sha256 === input.sha256
    && row.object_sha256 === input.sha256 && receipt.subject.object_key === row.object_key
    && row.event_payload.storage_key === row.object_key, 'RECEIPT_SUBJECT_MISMATCH')
  prove(row.receipt_digest === row.attempt_digest && row.receipt_signature === row.attempt_signature, 'SIGNATURE_COPY_MISMATCH')
  let verified = false
  try { verified = verifyAssetScanReceiptSignature(receipt, row.receipt_signature, trustedPublicKeyPem) } catch { verified = false }
  prove(verified, 'SIGNATURE_INVALID')
  prove(row.asset.id === input.assetId && row.asset.workspaceId === input.workspaceId && row.asset.sha256 === input.sha256
    && row.asset.scanStatus === 'clean' && row.asset.scanVerdict === 'clean'
    && row.asset.scanReceiptId === receipt.receipt_id && row.asset.scanReceiptDigest === digest
    && typeof row.asset.storageKey === 'string' && row.asset.storageKey === row.object_key.replace(/^quarantine\//u, 'clean/')
    && Number(row.asset.sourceRevision ?? 1) === row.asset_source_revision
    && Number(row.asset.revision) === Number(row.entity_version)
    && row.asset.scanCompletedAt === receipt.scan.completed_at, 'ASSET_SNAPSHOT_MISMATCH')

  return {
    status: 'passed', releaseProof: false, workspaceId: input.workspaceId, assetId: input.assetId, sha256: input.sha256,
    eventId: row.event_id, sourceRevision: row.asset_source_revision, callbackAcceptedAt: new Date(acceptedAt!).toISOString(),
    receiptId: receipt.receipt_id, receiptDigest: digest, keyId: input.trustedKeyId,
    signatureVerified: true, scanStatus: 'clean',
    database: { role: 'merchant_app', readOnly: true, rlsGuarded: true },
  }
}

const EVIDENCE_QUERY = `
SELECT e.id AS event_id, e.event_type, e.workspace_id, e.aggregate_id, e.payload AS event_payload,
  e.created_at AS event_created_at, e.published_at AS event_published_at, e.unknown_at AS event_unknown_at,
  e.lease_token IS NULL AND e.lease_until IS NULL AS event_unleased,
  s.entity_version, s.payload AS asset,
  a.asset_source_revision, a.outbox_event_id, a.callback_status, a.callback_attempts, a.callback_accepted_at,
  a.canonical_receipt, a.receipt AS attempt_receipt, a.callback_body,
  a.receipt_id AS attempt_receipt_id, a.receipt_digest AS attempt_digest, a.signature AS attempt_signature,
  r.receipt_id, r.receipt_digest, r.canonical_payload, r.receipt, r.signature AS receipt_signature,
  r.verdict, r.object_key, r.object_sha256
FROM outbox_events e
JOIN business_entity_snapshots s
  ON s.workspace_id = e.workspace_id AND s.entity_type = 'asset' AND s.entity_id = e.aggregate_id
JOIN asset_scan_attempts a
  ON a.workspace_id = e.workspace_id AND a.outbox_event_id = e.id
JOIN asset_scan_receipts r
  ON r.workspace_id = a.workspace_id AND r.receipt_id = a.receipt_id
WHERE e.workspace_id = $1 AND e.aggregate_id = $2 AND e.event_type = 'asset.uploaded'
  AND e.payload->>'sha256' = $3
ORDER BY a.asset_source_revision DESC
LIMIT 2`

async function readOnlyProof(client: PoolClient, input: EvidenceInput, trustedPublicKeyPem: string): Promise<ScannerCanaryProofSummary> {
  await client.query('BEGIN READ ONLY')
  try {
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [input.workspaceId])
    const identity = (await client.query(`SELECT current_user AS role, current_database() AS database,
      current_setting('transaction_read_only') AS read_only, current_setting('app.workspace_id', true) AS workspace_scope,
      r.rolsuper, r.rolbypassrls
      FROM pg_roles r WHERE r.rolname = current_user`)).rows[0]
    prove(identity?.role === 'merchant_app' && identity.database === 'merchant' && identity.read_only === 'on'
      && identity.workspace_scope === input.workspaceId && identity.rolsuper === false
      && identity.rolbypassrls === false, 'DATABASE_ROLE_UNSAFE')
    const rls = (await client.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, p.qual
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [['outbox_events', 'business_entity_snapshots', 'asset_scan_attempts', 'asset_scan_receipts']])).rows as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; qual: string | null }>
    prove(rls.length >= 4 && new Set(rls.map(table => table.relname)).size === 4
      && rls.every(table => table.relrowsecurity === true && table.relforcerowsecurity === true
        && typeof table.qual === 'string' && /workspace_id/u.test(table.qual) && /app\.workspace_id/u.test(table.qual)), 'RLS_NOT_ENFORCED')
    const rows = (await client.query(EVIDENCE_QUERY, [input.workspaceId, input.assetId, input.sha256])).rows as EvidenceRow[]
    prove(rows.length === 1, rows.length === 0 ? 'EVIDENCE_NOT_FOUND' : 'EVIDENCE_AMBIGUOUS')
    const summary = verifyScannerCanaryEvidence(input, rows[0]!, trustedPublicKeyPem)
    await client.query('COMMIT')
    return summary
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

function parseArgs(argv: string[]) {
  const values = new Map<string, string>()
  const allowed = new Set(['--workspace-id', '--asset-id', '--sha256', '--trusted-key-id'])
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    const value = argv[++i]
    if (!key || !allowed.has(key) || !value || value.startsWith('--') || values.has(key)) throw new Error('SCANNER_CANARY_EVIDENCE_ARGUMENTS_INVALID')
    values.set(key, value)
  }
  const get = (key: string) => {
    const value = values.get(key)
    if (!value) throw new Error(`SCANNER_CANARY_EVIDENCE_${key.slice(2).toUpperCase().replaceAll('-', '_')}_REQUIRED`)
    return value
  }
  return {
    input: { workspaceId: get('--workspace-id'), assetId: get('--asset-id'), sha256: get('--sha256'), trustedKeyId: get('--trusted-key-id') },
  }
}

export async function collectScannerCanaryEvidence(input: EvidenceInput, publicKeyPem: string, databaseUrl: string): Promise<ScannerCanaryProofSummary> {
  prove(typeof publicKeyPem === 'string' && publicKeyPem.includes('-----BEGIN PUBLIC KEY-----')
    && !publicKeyPem.includes('PRIVATE KEY'), 'PUBLIC_KEY_INVALID')
  try { createPublicKey(publicKeyPem) } catch { throw new Error('SCANNER_CANARY_EVIDENCE_PUBLIC_KEY_INVALID') }
  let parsed: URL
  try { parsed = new URL(databaseUrl) } catch { throw new Error('SCANNER_CANARY_EVIDENCE_DATABASE_URL_INVALID') }
  prove(['postgres:', 'postgresql:'].includes(parsed.protocol) && decodeURIComponent(parsed.username) === 'merchant_app'
    && Boolean(parsed.password), 'DATABASE_URL_INVALID')
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000, query_timeout: 12_000, options: '-c default_transaction_read_only=on',
    application_name: 'scanner-callback-canary-readonly-evidence' })
  try {
    const client = await pool.connect()
    try { return await readOnlyProof(client, input, publicKeyPem) }
    finally { client.release() }
  } finally { await pool.end() }
}

async function main(argv: string[]) {
  const { input } = parseArgs(argv)
  const databaseUrl = process.env.SCANNER_CANARY_DATABASE_URL
  prove(Boolean(databaseUrl), 'DATABASE_URL_REQUIRED')
  const keyringPath = process.env.SCANNER_CANARY_TRUSTED_KEYRING_FILE
  prove(Boolean(keyringPath), 'TRUSTED_KEYRING_REQUIRED')
  const resolvedKeyringPath = resolve(keyringPath!)
  prove(isAbsolute(resolvedKeyringPath), 'TRUSTED_KEYRING_PATH_INVALID')
  const info = await lstatFile(resolvedKeyringPath)
  const ownerId = typeof process.getuid === 'function' ? process.getuid() : undefined
  prove(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 65_536
    && (info.mode & 0o022) === 0 && (ownerId === undefined || info.uid === ownerId || info.uid === 0), 'TRUSTED_KEYRING_FILE_INVALID')
  let keyring: unknown
  try { keyring = JSON.parse(await readTextFile(resolvedKeyringPath, 'utf8')) } catch { throw new Error('SCANNER_CANARY_EVIDENCE_TRUSTED_KEYRING_INVALID') }
  prove(typeof keyring === 'object' && keyring !== null && !Array.isArray(keyring), 'TRUSTED_KEYRING_INVALID')
  const publicKeyPem = (keyring as Record<string, unknown>)[input.trustedKeyId]
  prove(typeof publicKeyPem === 'string', 'TRUSTED_KEY_ID_UNKNOWN')
  const summary = await collectScannerCanaryEvidence(input, publicKeyPem, databaseUrl!)
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    const message = error instanceof Error && /^SCANNER_CANARY_EVIDENCE_[A-Z0-9_]+$/u.test(error.message)
      ? error.message : 'SCANNER_CANARY_EVIDENCE_COLLECTION_FAILED'
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  })
}
