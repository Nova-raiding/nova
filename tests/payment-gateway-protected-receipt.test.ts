import { chmodSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { captureVerifiedNotifyReceipt } from '../services/payment-gateway/protected-receipt.mjs'

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
    const directory = mkdtempSync(join(tmpdir(), 'payment-receipt-'))
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
    const directory = mkdtempSync(join(tmpdir(), 'payment-receipt-'))
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
})
