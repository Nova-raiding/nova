import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assetScanReceiptDigest,
  parseAssetScanReceipt,
  signAssetScanReceipt,
} from '../packages/security/src/asset-scan-receipt.js'
import { verifyScannerCanaryEvidence } from '../scripts/scanner-callback-canary-evidence.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

function fixture() {
  const workspaceId = 'ws_scan_canary'
  const assetId = 'ast_scan_canary'
  const digest = 'a'.repeat(64)
  const eventId = 'evt_scan_canary'
  const sourceRevision = 1
  const keyId = 'scanner-key-canary'
  const keys = generateKeyPairSync('ed25519')
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const receipt = parseAssetScanReceipt({
    schema_version: 'asset-scan-receipt/1.0',
    receipt_id: `scan_${sha(`${eventId}\0${sourceRevision}\0${digest}`)}`,
    scan_job_id: eventId,
    scan_attempt_id: `attempt_${sha(`${eventId}\0${sourceRevision}`)}`,
    issuer: { scanner_service_id: 'merchant-clamav', scanner_instance_id: 'scanner-canary-1', key_id: keyId },
    subject: { workspace_id: workspaceId, asset_id: assetId, asset_source_revision: sourceRevision,
      object_key: `quarantine/${workspaceId}/${assetId}/source.png`, sha256: digest, size_bytes: 32, mime_type: 'image/png' },
    scan: { verdict: 'clean', engine: 'clamav', engine_version: '1.5.3', definitions_version: '28132',
      policy_version: 'merchant-upload/1', started_at: '2026-09-24T02:00:00.000Z',
      completed_at: '2026-09-24T02:00:01.000Z', findings: [] },
    issued_at: '2026-09-24T02:00:01.000Z', expires_at: '2026-09-24T02:05:01.000Z',
  }, { now: new Date('2026-09-24T02:00:01.000Z') })
  const canonical = JSON.stringify(receipt)
  const signature = signAssetScanReceipt(receipt, privateKeyPem)
  const receiptDigest = assetScanReceiptDigest(receipt)
  const input = { workspaceId, assetId, sha256: digest, trustedKeyId: keyId }
  const row = {
    event_id: eventId, event_type: 'asset.uploaded', workspace_id: workspaceId, aggregate_id: assetId,
    event_payload: { asset_id: assetId, sha256: digest, storage_key: receipt.subject.object_key, source_revision: sourceRevision },
    event_created_at: '2026-09-24T01:59:59.000Z', event_published_at: '2026-09-24T02:00:00.000Z',
    event_unknown_at: null, event_unleased: true, entity_version: 2,
    asset: { id: assetId, workspaceId, sha256: digest, storageKey: `clean/${workspaceId}/${assetId}/source.png`, sourceRevision,
      revision: 2, scanStatus: 'clean', scanVerdict: 'clean', scanReceiptId: receipt.receipt_id,
      scanReceiptDigest: receiptDigest, scanCompletedAt: receipt.scan.completed_at },
    asset_source_revision: sourceRevision, outbox_event_id: eventId,
    callback_status: 'accepted', callback_attempts: 1, callback_accepted_at: '2026-09-24T02:00:02.000Z',
    canonical_receipt: canonical, attempt_receipt_id: receipt.receipt_id, attempt_digest: receiptDigest,
    attempt_signature: signature, receipt_id: receipt.receipt_id, receipt_digest: receiptDigest,
    canonical_payload: canonical, receipt, attempt_receipt: receipt,
    callback_body: JSON.stringify({ receipt, signature }), receipt_signature: signature, verdict: 'clean',
    object_key: receipt.subject.object_key, object_sha256: digest,
  }
  return { input, row, publicKeyPem }
}

describe('scanner callback canary DB proof binding', () => {
  it('accepts a complete exact-workspace, asset, digest and signed callback chain', () => {
    const { input, row, publicKeyPem } = fixture()
    expect(verifyScannerCanaryEvidence(input, row, publicKeyPem)).toMatchObject({
      status: 'passed', workspaceId: input.workspaceId, assetId: input.assetId, sha256: input.sha256,
      callbackAcceptedAt: '2026-09-24T02:00:02.000Z', signatureVerified: true, scanStatus: 'clean',
    })
  })

  it('rejects a receipt whose signature does not verify with the trusted scanner public key', () => {
    const { input, row } = fixture()
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(() => verifyScannerCanaryEvidence(input, row, other)).toThrow('SCANNER_CANARY_EVIDENCE_SIGNATURE_INVALID')
  })

  it('rejects an asset hash or callback state that differs from the canary binding', () => {
    const first = fixture()
    expect(() => verifyScannerCanaryEvidence({ ...first.input, sha256: 'b'.repeat(64) }, first.row, first.publicKeyPem))
      .toThrow('SCANNER_CANARY_EVIDENCE_EVENT_PAYLOAD_MISMATCH')
    const second = fixture()
    expect(() => verifyScannerCanaryEvidence(second.input, { ...second.row, callback_status: 'pending' }, second.publicKeyPem))
      .toThrow('SCANNER_CANARY_EVIDENCE_CALLBACK_NOT_ACCEPTED')
  })

  it('rejects persisted receipt divergence and callbacks accepted before event publication', () => {
    const persisted = fixture()
    expect(() => verifyScannerCanaryEvidence(persisted.input, {
      ...persisted.row,
      receipt: { ...(persisted.row.receipt as object), receipt_id: 'scan_forged' },
    }, persisted.publicKeyPem)).toThrow('SCANNER_CANARY_EVIDENCE_PERSISTED_RECEIPT_MISMATCH')

    const chronology = fixture()
    expect(() => verifyScannerCanaryEvidence(chronology.input, {
      ...chronology.row,
      callback_accepted_at: '2026-09-24T01:59:59.500Z',
    }, chronology.publicKeyPem)).toThrow('SCANNER_CANARY_EVIDENCE_CALLBACK_CHRONOLOGY_INVALID')
  })

  it('rejects uncertain outbox events and does not label local evidence as release proof', () => {
    const unknown = fixture()
    expect(() => verifyScannerCanaryEvidence(unknown.input, {
      ...unknown.row,
      event_unknown_at: '2026-09-24T02:00:03.000Z',
    }, unknown.publicKeyPem)).toThrow('SCANNER_CANARY_EVIDENCE_EVENT_NOT_COMPLETED')

    const proof = fixture()
    expect(verifyScannerCanaryEvidence(proof.input, proof.row, proof.publicKeyPem)).toMatchObject({ releaseProof: false })
  })
})
