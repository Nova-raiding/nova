import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AssetMetadata } from '../../../packages/application/src/service.js'
import { CUSTOMER_DELIVERY_UPLOAD_MAX_BYTES, customerDeliveryUploadPurpose, customerDeliveryUploadView, validateCustomerDeliveryUpload } from './customer-delivery-upload.js'

const upload = (bytes = Buffer.from('%PDF-1.7\ncontract')) => ({ purpose: 'contract', mime_type: 'application/pdf', content_base64: bytes.toString('base64') })
const metadata = (overrides: Partial<AssetMetadata> = {}): Partial<AssetMetadata> => ({
  id: 'asset_delivery', workspaceId: 'ws_delivery', name: 'contract.pdf', mimeType: 'application/pdf', sizeBytes: 16,
  storageKey: 'quarantine/ws_delivery/asset_delivery/source', scanStatus: 'quarantined', ...overrides,
})

describe('customer delivery upload admission and public projection (no scanner execution)', () => {
  it('projects explicit unscanned demo assets as ready only when enabled', () => {
    const asset = metadata({ storageKey: 'quarantine/ws_delivery/asset_delivery/source', scanStatus: 'unscanned', scanVerdict: undefined, scanReceiptId: undefined, scanReceiptDigest: undefined })
    expect(customerDeliveryUploadView(asset, 'contract')).toMatchObject({ scanStatus: 'pending', ready: false })
    expect(customerDeliveryUploadView(asset, 'contract', true)).toMatchObject({ scanStatus: 'unscanned', ready: true })
  })
  it('computes the actual SHA256 and normalizes MIME', () => {
    const params = upload()
    const sha256 = createHash('sha256').update(Buffer.from(params.content_base64, 'base64')).digest('hex')
    expect(validateCustomerDeliveryUpload({ ...params, mime_type: ' Application/PDF ', sha256 })).toEqual({ purpose: 'contract', mimeType: 'application/pdf', sha256 })
  })
  it.each(['payment', 'system_integration', 'functional_acceptance', 'training'] as const)('admits document evidence for %s', purpose => {
    expect(validateCustomerDeliveryUpload({ ...upload(), purpose })).toMatchObject({ purpose, mimeType: 'application/pdf' })
  })
  it.each([undefined, '', 'image', 'CONTRACT'])('rejects invalid purpose %s', purpose => {
    expect(() => customerDeliveryUploadPurpose(purpose)).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })
  it.each([
    ['contract', 'video/mp4'], ['video', 'application/pdf'], ['contract', 'image/svg+xml'], ['video', 'video/quicktime'],
  ])('rejects a MIME outside purpose %s: %s', (purpose, mime_type) => {
    expect(() => validateCustomerDeliveryUpload({ ...upload(), purpose, mime_type })).toThrowError(expect.objectContaining({ code: 'CUSTOMER_DELIVERY_UPLOAD_TYPE_UNSUPPORTED' }))
  })
  it.each(['Zg=', 'Zg', '====', 'AAAA\n', 'AAAA AA=', 'AA=A', 'AA-_', 'A==='])('rejects malformed base64 %s', content_base64 => {
    expect(() => validateCustomerDeliveryUpload({ ...upload(), content_base64 })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }))
  })
  it.each([Buffer.from('a'), Buffer.from('ab'), Buffer.from('abc')])('accepts valid base64 padding', bytes => {
    expect(validateCustomerDeliveryUpload(upload(bytes)).sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  })
  it('rejects empty content and an incorrect digest', () => {
    expect(() => validateCustomerDeliveryUpload(upload(Buffer.alloc(0)))).toThrowError(expect.objectContaining({ code: 'CUSTOMER_DELIVERY_UPLOAD_SIZE_LIMIT' }))
    expect(() => validateCustomerDeliveryUpload({ ...upload(), sha256: '0'.repeat(64) })).toThrowError(expect.objectContaining({ code: 'CUSTOMER_DELIVERY_UPLOAD_DIGEST_MISMATCH' }))
  })
  it('handles the full 50 MiB bound without regular-expression stack overflow and rejects one byte over', () => {
    const bytes = Buffer.alloc(CUSTOMER_DELIVERY_UPLOAD_MAX_BYTES, 65)
    expect(validateCustomerDeliveryUpload(upload(bytes)).sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(() => validateCustomerDeliveryUpload(upload(Buffer.alloc(CUSTOMER_DELIVERY_UPLOAD_MAX_BYTES + 1)))).toThrowError(expect.objectContaining({ code: 'CUSTOMER_DELIVERY_UPLOAD_SIZE_LIMIT' }))
  })
  it('projects quarantine as pending without leaking storage paths or scanner secrets', () => {
    expect(customerDeliveryUploadView(metadata(), 'contract')).toEqual({ assetRef: 'asset_delivery', name: 'contract.pdf', mimeType: 'application/pdf', sizeBytes: 16, scanStatus: 'pending', ready: false })
  })
  it.each(['blocked', 'clean'] as const)('does not turn untrusted %s metadata into ready', scanStatus => {
    expect(customerDeliveryUploadView(metadata({ scanStatus }), 'contract')).toMatchObject({ scanStatus: 'blocked', ready: false })
  })
  it('recognizes only previously admitted trusted-clean metadata (synthetic predicate fixture)', () => {
    const asset = metadata({ storageKey: 'clean/ws_delivery/asset_delivery/source', scanStatus: 'clean', scanVerdict: 'clean', scanReceiptId: 'predicate-fixture-only', scanReceiptDigest: 'a'.repeat(64) })
    expect(customerDeliveryUploadView(asset, 'contract')).toMatchObject({ scanStatus: 'clean', ready: true })
  })
  it('returns not found for absent and wrong-purpose assets', () => {
    for (const [asset, purpose] of [[undefined, 'contract'], [metadata(), 'video']] as const) {
      expect(() => customerDeliveryUploadView(asset, purpose)).toThrowError(expect.objectContaining({ code: 'CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND' }))
    }
  })
})
