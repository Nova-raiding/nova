import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { captureGatewayOperationReceipt, captureVerifiedNotifyReceipt } from '../services/payment-gateway/protected-receipt.mjs'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const input = (directory: string) => ({
  directory,
  providerSignatureVerified: true,
  nativeSignature: 'sensitive-native-signature',
  nativeSignedFields: 'buyer_id=sensitive-buyer&out_trade_no=sensitive-order',
  apiCallbackStatus: 200,
  callbackPath: '/v1/billing/callback/alipay',
  orderId: 'sensitive-order',
  providerTradeId: 'sensitive-trade',
  workspaceId: 'sensitive-workspace',
  amountFen: 1,
  state: 'paid',
})

describe('protected Alipay native callback source receipt', () => {
  it('stores a private, immutable, redacted source receipt after verification and API acceptance', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'payment-receipt-'))
    chmodSync(directory, 0o700)
    const first = captureVerifiedNotifyReceipt(input(directory))
    const second = captureVerifiedNotifyReceipt(input(directory))
    if (!first || !second) throw new Error('protected receipt capture unexpectedly disabled')
    expect(first.request_id).not.toBe(second.request_id)
    const files = readdirSync(directory)
    expect(files).toHaveLength(2)
    const stored = readFileSync(join(directory, `${first.request_id}.json`), 'utf8')
    expect(stored).not.toMatch(/sensitive-(?:native|buyer|order|trade|workspace)/u)
    expect(stored).toContain(digest('sensitive-order'))
    expect(stored).toContain(digest('sensitive-trade'))
    expect(stored).toContain(digest('sensitive-native-signature'))
    expect(statSync(join(directory, `${first.request_id}.json`)).mode & 0o777).toBe(0o600)
    expect(first).toMatchObject({ source: 'alipay_native_notify', provider_signature_verified: true, api_callback_status: 200, raw_body_stored: false, final_evidence: false })
  })

  it('refuses an unverified, unsuccessful or non-private capture', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'payment-receipt-'))
    chmodSync(directory, 0o700)
    expect(() => captureVerifiedNotifyReceipt({ ...input(directory), providerSignatureVerified: false })).toThrow(/verified provider signature/u)
    expect(() => captureVerifiedNotifyReceipt({ ...input(directory), apiCallbackStatus: 502 })).toThrow(/accepted API callback/u)
    expect(readdirSync(directory)).toHaveLength(0)
    chmodSync(directory, 0o755)
    expect(() => captureVerifiedNotifyReceipt(input(directory))).toThrow(/private directory/u)
    expect(readdirSync(directory)).toHaveLength(0)
  })

  it('remains disabled without an explicit protected directory', () => {
    expect(captureVerifiedNotifyReceipt({ ...input(''), directory: undefined })).toBeNull()
  })

  it('rejects a symlink in a parent path even when the final directory is private', () => {
    const parent = mkdtempSync(join(realpathSync(tmpdir()), 'payment-receipt-parent-'))
    const realParent = join(parent, 'real')
    const directory = join(realParent, 'receipts')
    mkdirSync(realParent, { mode: 0o700 })
    mkdirSync(directory, { mode: 0o700 })
    symlinkSync(realParent, join(parent, 'alias'))
    expect(() => captureVerifiedNotifyReceipt(input(join(parent, 'alias', 'receipts')))).toThrow(/canonical/u)
    expect(readdirSync(directory)).toHaveLength(0)
  })
})

describe('protected Alipay gateway operation source receipts', () => {
  it('records signed checkout and verified provider query/refund without plaintext identifiers or claiming final evidence', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'gateway-operation-receipt-'))
    chmodSync(directory, 0o700)
    const common = { directory, orderId: 'sensitive-order', workspaceId: 'sensitive-workspace', amountFen: 29 }
    const checkout = captureGatewayOperationReceipt({ ...common, operation: 'checkout', signedCheckoutParams: 'sensitive-signed-params', outcome: 'created' })
    const query = captureGatewayOperationReceipt({ ...common, operation: 'provider_query', providerResponseSignatureVerified: true, providerTradeId: 'sensitive-trade', providerResponseReference: 'sensitive-request', outcome: 'paid' })
    const refund = captureGatewayOperationReceipt({ ...common, operation: 'refund', providerResponseSignatureVerified: true, providerTradeId: 'sensitive-trade', providerResponseReference: 'sensitive-request', refundRequestId: 'sensitive-refund', outcome: 'processing' })
    const refundQuery = captureGatewayOperationReceipt({ ...common, operation: 'refund_query', providerResponseSignatureVerified: true, providerTradeId: 'sensitive-trade', providerResponseReference: 'sensitive-request', refundRequestId: 'sensitive-refund', signedResponseSha256: digest('sensitive-signed-response'), providerNativeStatus: 'REFUND_SUCCESS', outcome: 'succeeded' })
    expect(readdirSync(directory)).toHaveLength(4)
    for (const receipt of [checkout, query, refund, refundQuery]) {
      if (!receipt) throw new Error('protected capture unexpectedly disabled')
      const stored = readFileSync(join(directory, `${receipt.request_id}.json`), 'utf8')
      expect(stored).not.toContain('sensitive-')
      expect(stored).toContain(digest('sensitive-order'))
      expect(statSync(join(directory, `${receipt.request_id}.json`)).mode & 0o777).toBe(0o600)
      expect(receipt).toMatchObject({ raw_body_stored: false, final_evidence: false })
    }
    expect(checkout?.source).toBe('alipay_signed_checkout')
    expect(query?.source).toBe('alipay_verified_response')
    expect(refund?.outcome).toBe('processing')
    expect(refundQuery).toMatchObject({ operation: 'refund_query', provider_native_status: 'REFUND_SUCCESS', signed_response_sha256: digest('sensitive-signed-response'), ledger_state_observed: false, final_evidence: false })
  })

  it('refuses unsupported or unverified operation claims', () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), 'gateway-operation-receipt-'))
    chmodSync(directory, 0o700)
    const common = { directory, orderId: 'order', workspaceId: 'workspace', amountFen: 1 }
    expect(() => captureGatewayOperationReceipt({ ...common, operation: 'provider_query', providerTradeId: 'trade', providerResponseReference: 'request', outcome: 'paid' })).toThrow(/verified response/u)
    expect(() => captureGatewayOperationReceipt({ ...common, operation: 'provider_query', providerResponseSignatureVerified: true, providerTradeId: 'trade', providerResponseReference: 'request', outcome: 'pending' })).toThrow(/paid result/u)
    expect(() => captureGatewayOperationReceipt({ ...common, operation: 'checkout', signedCheckoutParams: 'signed', outcome: 'paid' })).toThrow(/signed checkout/u)
    const refundQuery = { ...common, operation: 'refund_query' as const, providerResponseSignatureVerified: true, providerTradeId: 'trade', providerResponseReference: 'request', refundRequestId: 'refund', signedResponseSha256: digest('response'), providerNativeStatus: 'REFUND_SUCCESS', outcome: 'succeeded' }
    expect(() => captureGatewayOperationReceipt({ ...refundQuery, providerNativeStatus: 'SUCCESS' })).toThrow(/native success/u)
    expect(() => captureGatewayOperationReceipt({ ...refundQuery, signedResponseSha256: undefined })).toThrow(/signed response/u)
    expect(() => captureGatewayOperationReceipt({ ...refundQuery, refundRequestId: undefined })).toThrow(/refund request/u)
    expect(readdirSync(directory)).toHaveLength(0)
  })
})
