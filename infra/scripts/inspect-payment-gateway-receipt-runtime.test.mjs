import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectPaymentGatewayReceiptRuntime } from './inspect-payment-gateway-receipt-runtime.mjs'

function fixture(t) {
  const protectedRoot = mkdtempSync(join(realpathSync(tmpdir()), 'gateway-receipt-runtime-'))
  t.after(() => rmSync(protectedRoot, { recursive: true, force: true }))
  const intermediate = join(protectedRoot, 'candidate')
  const expectedHostDir = join(intermediate, 'payment-receipts')
  mkdirSync(intermediate, { mode: 0o700 })
  mkdirSync(expectedHostDir, { mode: 0o700 })
  const inspect = { Config: { User: '100:101' }, State: { Running: true, Health: { Status: 'healthy' } },
    HostConfig: { ReadonlyRootfs: true, Privileged: false },
    Mounts: [{ Type: 'bind', Source: expectedHostDir, Destination: '/run/payment-receipts', RW: true }] }
  const review = () => inspectPaymentGatewayReceiptRuntime({ inspect, expectedHostDir, protectedRoot,
    rootUid: process.getuid(), gatewayUid: process.getuid() })
  return { protectedRoot, intermediate, expectedHostDir, inspect, review }
}

test('writable private sink passes review without claiming release or payment evidence', t => {
  assert.deepEqual(fixture(t).review(), { schema_version: 'payment-gateway-receipt-runtime-review.v1',
    sink_writable_by_gateway_uid: true, review_only: true, release_binding_verified: false,
    provider_and_ledger_reconciled: false, final_evidence: false })
})

test('healthy gateway with inaccessible receipt directory is refused', t => {
  const value = fixture(t)
  chmodSync(value.expectedHostDir, 0o755)
  assert.throws(value.review, /gateway UID mode 0700/)
  chmodSync(value.expectedHostDir, 0o700)
  chmodSync(value.intermediate, 0o777)
  assert.throws(value.review, /parent ownership or mode/)
})

test('missing, read-only or redirected receipt mount is refused', t => {
  const value = fixture(t)
  value.inspect.Mounts = []
  assert.throws(value.review, /exactly one writable/)
  value.inspect.Mounts = [{ Type: 'bind', Source: value.expectedHostDir, Destination: '/run/payment-receipts', RW: false }]
  assert.throws(value.review, /exactly one writable/)
  value.inspect.Mounts[0].RW = true
  value.inspect.Mounts[0].Source = '/other/payment-receipts'
  assert.throws(value.review, /exactly one writable/)
})

test('unsafe gateway identity, host privileges and symlinked sink are refused', t => {
  const value = fixture(t)
  value.inspect.Config.User = '0:0'
  assert.throws(value.review, /UID 100:101/)
  value.inspect.Config.User = '100:101'
  value.inspect.HostConfig.ReadonlyRootfs = false
  assert.throws(value.review, /read-only/)
  value.inspect.HostConfig.ReadonlyRootfs = true
  rmSync(value.expectedHostDir, { recursive: true })
  const actual = join(value.intermediate, 'actual')
  mkdirSync(actual, { mode: 0o700 })
  symlinkSync(actual, value.expectedHostDir)
  assert.throws(value.review, /canonical/)
})
