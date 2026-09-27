import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyPaymentSourceTransfer } from './verify-payment-source-transfer.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const id = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const receipt = { schema_version: 'payment-gateway-source-receipt.v1', source: 'alipay_native_notify',
  observed_at: '2026-09-26T00:00:00.000Z', request_id: requestId,
  callback_path: '/v1/billing/callback/alipay', provider_signature_verified: true,
  api_callback_status: 200, order_id_sha256: 'a'.repeat(64), provider_trade_id_sha256: 'b'.repeat(64),
  workspace_id_sha256: 'c'.repeat(64), native_signature_sha256: 'd'.repeat(64),
  native_signed_fields_sha256: 'e'.repeat(64), amount_fen: 100, state: 'paid',
  raw_body_stored: false, final_evidence: false }

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'payment-transfer-review-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'attempt')
  mkdirSync(directory, { mode: 0o700 })
  const copiedPath = join(directory, `${id}.source.json`)
  const recordPath = join(directory, `${id}.transfer.json`)
  const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`)
  const record = { schema_version: 'payment-source-receipt-transfer.v1',
    source_receipt_sha256: hash(bytes), copied_receipt_sha256: hash(bytes), source_path_sha256: 'f'.repeat(64),
    source_uid: 100, source_mode: '0600', source_device: '1', source_inode: '2',
    transferred_at: '2026-09-26T00:00:01.000Z', copied_filename: `${id}.source.json`,
    release_binding_verified: false, final_evidence: false }
  writeFileSync(copiedPath, bytes, { mode: 0o600 })
  writeFileSync(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  return { root, directory, copiedPath, recordPath, record, bytes,
    verify: () => verifyPaymentSourceTransfer({ recordPath, evidenceRoot: root }) }
}

test('independent review accepts exact private copy but never grants provenance or final evidence', t => {
  const sample = fixture(t)
  assert.deepEqual(sample.verify(), { schema_version: 'payment-source-transfer-review.v1', status: 'pass',
    review_only: true, copied_bytes_consistent: true, source_origin_verified: false,
    release_binding_verified: false, provider_and_ledger_reconciled: false, final_evidence: false })
})

test('independent review rejects changed receipt bytes and a forged hash', t => {
  const sample = fixture(t)
  writeFileSync(sample.copiedPath, Buffer.from(`${JSON.stringify({ ...receipt, amount_fen: 200 })}\n`))
  assert.throws(sample.verify, /SHA-256 differs/)
  writeFileSync(sample.copiedPath, sample.bytes)
  writeFileSync(sample.recordPath, `${JSON.stringify({ ...sample.record, source_receipt_sha256: '0'.repeat(64) })}\n`)
  assert.throws(sample.verify, /SHA-256 differs/)
})

test('independent review rejects widened permissions, links and altered contract', t => {
  const sample = fixture(t)
  chmodSync(sample.copiedPath, 0o644)
  assert.throws(sample.verify, /owner, mode or size/)
  chmodSync(sample.copiedPath, 0o600)
  rmSync(sample.copiedPath)
  const other = join(sample.directory, 'other.json')
  writeFileSync(other, sample.bytes, { mode: 0o600 })
  symlinkSync(other, sample.copiedPath)
  assert.throws(sample.verify, /ELOOP|symbolic link|too many levels/i)
  rmSync(sample.copiedPath)
  writeFileSync(sample.copiedPath, sample.bytes, { mode: 0o600 })
  writeFileSync(sample.recordPath, `${JSON.stringify({ ...sample.record, final_evidence: true })}\n`)
  assert.throws(sample.verify, /exact review-only transfer contract/)
})

test('independent review rejects noncanonical or misplaced transfer records', t => {
  const sample = fixture(t)
  assert.throws(() => verifyPaymentSourceTransfer({ recordPath: join(sample.root, 'other.transfer.json'), evidenceRoot: sample.root }), /outside the canonical evidence root/)
  assert.throws(() => verifyPaymentSourceTransfer({ recordPath: sample.recordPath, evidenceRoot: sample.directory }), /outside the canonical evidence root/)
})
