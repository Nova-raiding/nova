import assert from 'node:assert/strict'
import { test } from 'node:test'
import { transferPaymentSourceReceipt, validateSourceReceipt, validateSourceReceiptBytes } from './transfer-payment-source-receipt.mjs'

const root = '/var/lib/merchant-release-security'
const base = { sourcePath: `${root}/payment-receipts/00000000-0000-0000-0000-000000000000.json`, sourceRoot: `${root}/payment-receipts`, outputDirectory: `${root}/payment-evidence/attempt`, readerUid: 502 }
const hash = 'a'.repeat(64)
const common = { observed_at: '2026-09-26T00:00:00.000Z', request_id: '11111111-1111-4111-8111-111111111111', order_id_sha256: hash, workspace_id_sha256: hash, amount_fen: 100, raw_body_stored: false, final_evidence: false }

test('payment transfer accepts exact callback and operation receipt schemas only', () => {
  const callback = { schema_version: 'payment-gateway-source-receipt.v1', source: 'alipay_native_notify', ...common, callback_path: '/v1/billing/callback/alipay', provider_signature_verified: true, api_callback_status: 200, provider_trade_id_sha256: hash, native_signature_sha256: hash, native_signed_fields_sha256: hash, state: 'paid' }
  const operationBase = { schema_version: 'payment-gateway-operation-source-receipt.v1', source: 'alipay_verified_response', ...common, operation: 'provider_query', provider_trade_id_sha256: hash, provider_response_reference_sha256: hash, outcome: 'paid', provider_response_signature_verified: true }
  const fixtures = [
    [callback, 'payment-gateway-source-receipt.v1'],
    [{ ...operationBase, operation: 'checkout', source: 'alipay_signed_checkout', provider_trade_id_sha256: undefined, provider_response_reference_sha256: undefined, provider_response_signature_verified: false, outcome: 'created', signed_checkout_params_sha256: hash }, 'payment-gateway-operation-source-receipt.v1'],
    [operationBase, 'payment-gateway-operation-source-receipt.v1'],
    [{ ...operationBase, operation: 'refund', refund_request_id_sha256: hash, outcome: 'processing' }, 'payment-gateway-operation-source-receipt.v1'],
    [{ ...operationBase, operation: 'refund_query', refund_request_id_sha256: hash, signed_response_sha256: hash, provider_native_status: 'REFUND_SUCCESS', ledger_state_observed: false, outcome: 'succeeded' }, 'payment-gateway-operation-source-receipt.v1'],
  ]
  for (const [receipt, schema] of fixtures) {
    // Undefined properties are not emitted by the real producer.
    const exact = Object.fromEntries(Object.entries(receipt).filter(([, value]) => value !== undefined))
    assert.equal(validateSourceReceipt(exact, `${common.request_id}.json`), true, schema)
  }
  assert.equal(callback.final_evidence, false)
  assert.equal(operationBase.final_evidence, false)
})

test('payment transfer rejects unknown metadata and secret-like fields before byte copy', () => {
  const valid = { schema_version: 'payment-gateway-source-receipt.v1', source: 'alipay_native_notify', ...common, callback_path: '/v1/billing/callback/alipay', provider_signature_verified: true, api_callback_status: 200, provider_trade_id_sha256: hash, native_signature_sha256: hash, native_signed_fields_sha256: hash, state: 'paid' }
  assert.equal(validateSourceReceipt({ ...valid, diagnostics: 'unexpected' }, `${common.request_id}.json`), false)
  assert.equal(validateSourceReceipt({ ...valid, access_token: 'secret-token' }, `${common.request_id}.json`), false)
  assert.equal(validateSourceReceipt({ ...valid, signed_fields: 'private payer data' }, `${common.request_id}.json`), false)
  assert.equal(validateSourceReceipt({ ...valid, final_evidence: true }, `${common.request_id}.json`), false)
  const canonical = Buffer.from(`${JSON.stringify(valid)}\n`)
  assert.equal(validateSourceReceiptBytes(canonical, `${common.request_id}.json`), true)
  const duplicatedAllowedKey = Buffer.from(canonical.toString().replace('"state":"paid"', '"state":"payer-secret","state":"paid"'))
  assert.equal(validateSourceReceiptBytes(duplicatedAllowedKey, `${common.request_id}.json`), false, 'duplicate keys must not hide arbitrary bytes from parsed schema validation')
})

test('payment transfer refuses unprivileged execution before reading a protected receipt', () => {
  if (process.getuid() === 0) return
  assert.throws(() => transferPaymentSourceReceipt(base), /host root/)
})

test('payment transfer refuses gateway uid as the evidence reader', () => {
  assert.throws(() => transferPaymentSourceReceipt({ ...base, readerUid: 100 }), /independent evidence reader uid/)
  assert.throws(() => transferPaymentSourceReceipt({ ...base, readerUid: -1 }), /independent evidence reader uid/)
})

test('payment transfer refuses paths outside its fixed protected roots', () => {
  for (const sourcePath of ['/tmp/00000000-0000-0000-0000-000000000000.json', `${root}/payment-receipts/../other/00000000-0000-0000-0000-000000000000.json`]) {
    assert.throws(() => transferPaymentSourceReceipt({ ...base, sourcePath, expectedSourceUid: process.getuid() }), /protected payment roots/)
  }
  assert.throws(() => transferPaymentSourceReceipt({ ...base, outputDirectory: '/tmp/attempt', expectedSourceUid: process.getuid() }), /protected payment roots/)
  assert.throws(() => transferPaymentSourceReceipt({ ...base, sourcePath: `${root}/payment-receipts/receipt.json`, expectedSourceUid: process.getuid() }), /filename is invalid/)
})
