import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { chownSync, chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { transferPaymentSourceReceipt } from '/test/transfer.mjs'

assert.equal(process.getuid(), 0, 'isolated payment transfer test requires container root')
const root = '/var/lib/merchant-release-security'
const sourceRoot = join(root, 'payment-receipts')
const outputRoot = join(root, 'payment-evidence')
const outputDirectory = join(outputRoot, 'synthetic-attempt')
mkdirSync(sourceRoot, { mode: 0o700 })
chownSync(sourceRoot, 100, 101)
chmodSync(sourceRoot, 0o700)
mkdirSync(outputRoot, { mode: 0o700 })
mkdirSync(outputDirectory, { mode: 0o700 })
chownSync(outputDirectory, 200, 201)
chmodSync(outputDirectory, 0o700)

const requestId = '11111111-1111-4111-8111-111111111111'
const sourcePath = join(sourceRoot, `${requestId}.json`)
const receipt = { schema_version: 'payment-gateway-source-receipt.v1', source: 'alipay_native_notify', observed_at: '2026-09-26T00:00:00.000Z', request_id: requestId, callback_path: '/v1/billing/callback/alipay', provider_signature_verified: true, api_callback_status: 200, order_id_sha256: 'a'.repeat(64), provider_trade_id_sha256: 'b'.repeat(64), workspace_id_sha256: 'c'.repeat(64), native_signature_sha256: 'd'.repeat(64), native_signed_fields_sha256: 'e'.repeat(64), amount_fen: 100, state: 'paid', raw_body_stored: false, final_evidence: false }
const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`)
writeFileSync(sourcePath, bytes, { mode: 0o600 })
chownSync(sourcePath, 100, 101)
chmodSync(sourcePath, 0o600)
const transferred = transferPaymentSourceReceipt({ sourcePath, sourceRoot, outputDirectory, readerUid: 200 })
const copied = readFileSync(transferred.receiptPath)
const record = JSON.parse(readFileSync(transferred.recordPath, 'utf8'))
assert.deepEqual(copied, bytes)
assert.deepEqual(readFileSync(sourcePath), bytes)
assert.equal(lstatSync(transferred.receiptPath).uid, 200)
assert.equal(lstatSync(transferred.recordPath).uid, 200)
assert.equal(lstatSync(transferred.receiptPath).mode & 0o777, 0o600)
assert.equal(record.source_receipt_sha256, createHash('sha256').update(bytes).digest('hex'))
assert.equal(record.release_binding_verified, false)
assert.equal(record.final_evidence, false)

const maliciousId = '66666666-6666-4666-8666-666666666666'
const maliciousPath = join(sourceRoot, `${maliciousId}.json`)
writeFileSync(maliciousPath, Buffer.from(`${JSON.stringify({ ...receipt, request_id: maliciousId, access_token: 'must-not-transfer' })}\n`), { mode: 0o600 })
chownSync(maliciousPath, 100, 101)
chmodSync(maliciousPath, 0o600)
const outputBeforeMalicious = readdirSync(outputDirectory).sort()
assert.throws(() => transferPaymentSourceReceipt({ sourcePath: maliciousPath, sourceRoot, outputDirectory, readerUid: 200 }), /exact receipt schema/u)
assert.deepEqual(readdirSync(outputDirectory).sort(), outputBeforeMalicious, 'receipt with an unknown secret field must not be copied')

const badId = '22222222-2222-4222-8222-222222222222'
const badPath = join(sourceRoot, `${badId}.json`)
writeFileSync(badPath, bytes, { mode: 0o600 })
chownSync(badPath, 100, 101)
chmodSync(badPath, 0o644)
assert.throws(() => transferPaymentSourceReceipt({ sourcePath: badPath, sourceRoot, outputDirectory, readerUid: 200 }), /owner, mode or size/)

const linkId = '33333333-3333-4333-8333-333333333333'
const linkPath = join(sourceRoot, `${linkId}.json`)
symlinkSync(sourcePath, linkPath)
assert.throws(() => transferPaymentSourceReceipt({ sourcePath: linkPath, sourceRoot, outputDirectory, readerUid: 200 }))

const mismatchId = '44444444-4444-4444-8444-444444444444'
const mismatchPath = join(sourceRoot, `${mismatchId}.json`)
writeFileSync(mismatchPath, bytes, { mode: 0o600 })
chownSync(mismatchPath, 100, 101)
chmodSync(mismatchPath, 0o600)
assert.throws(() => transferPaymentSourceReceipt({ sourcePath: mismatchPath, sourceRoot, outputDirectory, readerUid: 200 }), /not a gateway receipt/)

const faultId = '55555555-5555-4555-8555-555555555555'
const faultPath = join(sourceRoot, `${faultId}.json`)
const faultBytes = Buffer.from(`${JSON.stringify({ ...receipt, request_id: faultId })}\n`)
writeFileSync(faultPath, faultBytes, { mode: 0o600 })
chownSync(faultPath, 100, 101)
chmodSync(faultPath, 0o600)
const outputBeforeFault = readdirSync(outputDirectory).sort()
const originalWrite = fs.writeSync
fs.writeSync = (...args) => {
  if (Buffer.isBuffer(args[1]) && args[1].includes(Buffer.from('payment-source-receipt-transfer.v1'))) throw new Error('synthetic record write failure')
  return originalWrite(...args)
}
syncBuiltinESMExports()
try {
  assert.throws(() => transferPaymentSourceReceipt({ sourcePath: faultPath, sourceRoot, outputDirectory, readerUid: 200 }), /synthetic record write failure/)
} finally {
  fs.writeSync = originalWrite
  syncBuiltinESMExports()
}
assert.deepEqual(readdirSync(outputDirectory).sort(), outputBeforeFault, 'failed transfer must not leave a copied receipt or partial record')
assert.deepEqual(readFileSync(faultPath), faultBytes, 'failed transfer must not change gateway source')

process.stdout.write('synthetic payment receipt transfer: PASS (root copy, byte hash, uid/mode, symlink and changed-source refusal, partial write cleanup; REVIEW_ONLY)\n')
