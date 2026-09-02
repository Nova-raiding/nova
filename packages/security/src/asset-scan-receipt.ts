import { createHash, sign, verify } from 'node:crypto'

export const ASSET_SCAN_RECEIPT_SCHEMA = 'asset-scan-receipt/1.0' as const

export type AssetScanVerdict = 'clean' | 'malicious' | 'suspicious' | 'unsupported'

export interface AssetScanReceipt {
  schema_version: typeof ASSET_SCAN_RECEIPT_SCHEMA
  receipt_id: string
  scan_job_id: string
  scan_attempt_id: string
  issuer: {
    scanner_service_id: string
    scanner_instance_id: string
    key_id: string
  }
  subject: {
    workspace_id: string
    asset_id: string
    asset_source_revision: number
    object_key: string
    sha256: string
    size_bytes: number
    mime_type: string
  }
  scan: {
    verdict: AssetScanVerdict
    engine: string
    engine_version: string
    definitions_version: string
    policy_version: string
    started_at: string
    completed_at: string
    findings: string[]
  }
  issued_at: string
  expires_at: string
}

export interface SignedAssetScanReceipt {
  receipt: AssetScanReceipt
  signature: string
}

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`invalid ${field}`)
  return value
}

function iso(value: unknown, field: string): string {
  const result = text(value, field, 64)
  if (!Number.isFinite(Date.parse(result))) throw new Error(`invalid ${field}`)
  return result
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${field}`)
  return value as Record<string, unknown>
}

/** Parse into the frozen receipt shape. Unknown input properties are ignored by
 * construction and therefore never enter the signed canonical payload. */
export function parseAssetScanReceipt(value: unknown, options: { now?: Date; maxLifetimeMs?: number; clockSkewMs?: number } = {}): AssetScanReceipt {
  const root = object(value, 'receipt')
  if (root.schema_version !== ASSET_SCAN_RECEIPT_SCHEMA) throw new Error('invalid schema_version')
  const issuer = object(root.issuer, 'issuer')
  const subject = object(root.subject, 'subject')
  const scan = object(root.scan, 'scan')
  const sourceRevision = Number(subject.asset_source_revision)
  const sizeBytes = Number(subject.size_bytes)
  const findings = scan.findings
  if (typeof subject.asset_source_revision !== 'number' || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1) throw new Error('invalid asset_source_revision')
  if (typeof subject.size_bytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > 50 * 1024 * 1024) throw new Error('invalid size_bytes')
  if (!Array.isArray(findings) || findings.length > 32 || findings.some(item => typeof item !== 'string' || !item.trim() || item.length > 256 || /[\u0000-\u001f\u007f]/u.test(item))) throw new Error('invalid findings')
  const verdict = scan.verdict
  if (!['clean', 'malicious', 'suspicious', 'unsupported'].includes(String(verdict))) throw new Error('invalid verdict')
  const receipt: AssetScanReceipt = {
    schema_version: ASSET_SCAN_RECEIPT_SCHEMA,
    receipt_id: text(root.receipt_id, 'receipt_id', 128),
    scan_job_id: text(root.scan_job_id, 'scan_job_id', 128),
    scan_attempt_id: text(root.scan_attempt_id, 'scan_attempt_id', 128),
    issuer: {
      scanner_service_id: text(issuer.scanner_service_id, 'scanner_service_id', 128),
      scanner_instance_id: text(issuer.scanner_instance_id, 'scanner_instance_id', 256),
      key_id: text(issuer.key_id, 'key_id', 128),
    },
    subject: {
      workspace_id: text(subject.workspace_id, 'workspace_id', 128),
      asset_id: text(subject.asset_id, 'asset_id', 128),
      asset_source_revision: sourceRevision,
      object_key: text(subject.object_key, 'object_key', 1024),
      sha256: text(subject.sha256, 'sha256', 64).toLowerCase(),
      size_bytes: sizeBytes,
      mime_type: text(subject.mime_type, 'mime_type', 128).toLowerCase(),
    },
    scan: {
      verdict: verdict as AssetScanVerdict,
      engine: text(scan.engine, 'engine', 64),
      engine_version: text(scan.engine_version, 'engine_version', 128),
      definitions_version: text(scan.definitions_version, 'definitions_version', 256),
      policy_version: text(scan.policy_version, 'policy_version', 128),
      started_at: iso(scan.started_at, 'started_at'),
      completed_at: iso(scan.completed_at, 'completed_at'),
      findings: [...findings] as string[],
    },
    issued_at: iso(root.issued_at, 'issued_at'),
    expires_at: iso(root.expires_at, 'expires_at'),
  }
  if (!/^[a-f0-9]{64}$/u.test(receipt.subject.sha256)) throw new Error('invalid sha256')
  const objectKeySegments = receipt.subject.object_key.split('/')
  if (objectKeySegments.length < 4
    || objectKeySegments[0] !== 'quarantine'
    || objectKeySegments[1] !== receipt.subject.workspace_id
    || objectKeySegments[2] !== receipt.subject.asset_id
    || objectKeySegments.slice(3).some(segment => segment.length === 0)
    || receipt.subject.object_key.includes('\\')
    || objectKeySegments.some(segment => segment === '.' || segment === '..')) throw new Error('invalid object_key')
  const started = Date.parse(receipt.scan.started_at)
  const completed = Date.parse(receipt.scan.completed_at)
  const issued = Date.parse(receipt.issued_at)
  const expires = Date.parse(receipt.expires_at)
  if (started > completed || completed > issued || issued >= expires) throw new Error('invalid receipt chronology')
  const maxLifetimeMs = options.maxLifetimeMs ?? 5 * 60_000
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0 || maxLifetimeMs > 15 * 60_000) throw new Error('receipt lifetime policy is invalid')
  if (expires - issued > maxLifetimeMs) throw new Error('receipt lifetime exceeds policy')
  const now = (options.now ?? new Date()).getTime()
  const clockSkewMs = options.clockSkewMs ?? 60_000
  if (!Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0 || clockSkewMs > 15 * 60_000) throw new Error('receipt clock skew policy is invalid')
  if (issued > now + clockSkewMs) throw new Error('receipt issued in the future')
  if (expires < now - clockSkewMs) throw new Error('receipt expired')
  if (receipt.scan.verdict === 'clean' && receipt.scan.findings.length) throw new Error('clean receipt cannot contain findings')
  if (receipt.scan.verdict !== 'clean' && receipt.scan.findings.length === 0) throw new Error('blocked receipt requires findings')
  return receipt
}

export function canonicalAssetScanReceipt(receipt: AssetScanReceipt): string {
  return JSON.stringify(receipt)
}

export function assetScanReceiptDigest(receipt: AssetScanReceipt): string {
  return createHash('sha256').update(canonicalAssetScanReceipt(receipt)).digest('hex')
}

export function signAssetScanReceipt(receipt: AssetScanReceipt, privateKeyPem: string): string {
  return sign(null, Buffer.from(canonicalAssetScanReceipt(receipt)), privateKeyPem).toString('base64url')
}

export function verifyAssetScanReceiptSignature(receipt: AssetScanReceipt, signature: string, publicKeyPem: string): boolean {
  // Ed25519 signatures are 86 base64url characters, while an RSA-2048
  // signature is 342. Keep a strict alphabet and an explicit upper bound,
  // but do not reject a valid production key solely because its algorithm
  // produces a larger signature.
  if (typeof signature !== 'string' || typeof publicKeyPem !== 'string' || !/^[A-Za-z0-9_-]{40,2048}$/u.test(signature)) return false
  try { return verify(null, Buffer.from(canonicalAssetScanReceipt(receipt)), publicKeyPem, Buffer.from(signature, 'base64url')) }
  catch { return false }
}
