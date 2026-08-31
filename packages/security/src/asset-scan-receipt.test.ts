import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assetScanReceiptDigest, parseAssetScanReceipt, signAssetScanReceipt, verifyAssetScanReceiptSignature } from './asset-scan-receipt.js'

function fixture(now = new Date('2026-08-30T05:00:30.000Z')) {
  return parseAssetScanReceipt({
    schema_version: 'asset-scan-receipt/1.0', receipt_id: 'scan_receipt_1', scan_job_id: 'event_1', scan_attempt_id: 'attempt_1',
    issuer: { scanner_service_id: 'merchant-clamav', scanner_instance_id: 'scanner-1', key_id: 'scanner-key-1' },
    subject: { workspace_id: 'ws_1', asset_id: 'asset_1', asset_source_revision: 1, object_key: 'quarantine/ws_1/asset_1/file.png', sha256: 'a'.repeat(64), size_bytes: 42, mime_type: 'image/png' },
    scan: { verdict: 'clean', engine: 'clamav', engine_version: '1.5.3', definitions_version: '27654/2026-08-30', policy_version: 'merchant-upload/1', started_at: '2026-08-30T05:00:00.000Z', completed_at: '2026-08-30T05:00:01.000Z', findings: [] },
    issued_at: '2026-08-30T05:00:01.000Z', expires_at: '2026-08-30T05:05:01.000Z',
  }, { now })
}

describe('asset scan receipt', () => {
  it('signs and verifies the exact frozen receipt body', () => {
    const keys = generateKeyPairSync('ed25519')
    const receipt = fixture()
    const signature = signAssetScanReceipt(receipt, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
    expect(verifyAssetScanReceiptSignature(receipt, signature, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(true)
    expect(verifyAssetScanReceiptSignature({ ...receipt, subject: { ...receipt.subject, sha256: 'b'.repeat(64) } }, signature, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(false)
    expect(assetScanReceiptDigest(receipt)).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('accepts a bounded RSA signature and rejects oversized input', () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const receipt = fixture()
    const signature = signAssetScanReceipt(receipt, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())

    expect(signature.length).toBeGreaterThan(256)
    expect(verifyAssetScanReceiptSignature(receipt, signature, keys.publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(true)
    expect(verifyAssetScanReceiptSignature(receipt, 'A'.repeat(2049), keys.publicKey.export({ type: 'spki', format: 'pem' }).toString())).toBe(false)
  })

  it('fails closed for expired, malformed and contradictory receipts', () => {
    expect(() => fixture(new Date('2026-08-30T06:00:00.000Z'))).toThrow('expired')
    expect(() => parseAssetScanReceipt({ ...fixture(), subject: { ...fixture().subject, object_key: 'clean/ws_1/asset_1/file.png' } }, { now: new Date('2026-08-30T05:00:30.000Z') })).toThrow('object_key')
    expect(() => parseAssetScanReceipt({ ...fixture(), scan: { ...fixture().scan, findings: ['Eicar-Test-Signature'] } }, { now: new Date('2026-08-30T05:00:30.000Z') })).toThrow('clean receipt')
  })
})
