import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { readRefundLedgerSnapshot, validateRefundBinding, validateRefundSnapshotPair, validateRefundSourceReceipt } from './payment-refund-ledger-snapshot.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const binding = { release_id: 'release-20260926', deployment_nonce: 'abcdefghijklmnopqrstuv', order_id: 'order-123', workspace_id: 'ws-test', provider_trade_id: 'trade-123', refund_request_id: 'refund-123', reservation_key: 'recharge-refund:order-123:1', amount_fen: 100 }
const source = (operation, requestId, observedAt) => ({ schema_version: 'payment-gateway-operation-source-receipt.v1', source: 'alipay_verified_response', operation, request_id: requestId, observed_at: observedAt, provider_response_signature_verified: true, raw_body_stored: false, final_evidence: false, order_id_sha256: hash(binding.order_id), workspace_id_sha256: hash(binding.workspace_id), provider_trade_id_sha256: hash(binding.provider_trade_id), provider_response_reference_sha256: hash(binding.provider_trade_id), refund_request_id_sha256: hash(binding.refund_request_id), amount_fen: 100, outcome: operation === 'refund' ? 'processing' : 'succeeded', ...(operation === 'refund_query' ? { provider_native_status: 'REFUND_SUCCESS', signed_response_sha256: hash('signed-response'), ledger_state_observed: false } : {}) })
const snapshot = (phase, requestId, sourceAt, observedAt) => ({ phase, claimed_release_id: binding.release_id, claimed_deployment_nonce: binding.deployment_nonce, release_binding_verified: false, source_provenance_verified: false, final_evidence: false, source_receipt_sha256: hash('source-receipt'), order_id_sha256: hash(binding.order_id), workspace_id_sha256: hash(binding.workspace_id), provider_trade_id_sha256: hash(binding.provider_trade_id), refund_request_id_sha256: hash(binding.refund_request_id), reservation_key_sha256: hash(binding.reservation_key), amount_fen: 100, release_count: 0, recharge_transaction_sha256: hash('recharge-row'), reservation_transaction_sha256: hash('reservation-row'), source_request_id: requestId, source_observed_at: sourceAt, observed_at: observedAt, order_state: phase === 'before' ? 'paid' : 'closed' })

test('fixed refund binding and real signed source receipts are required', () => {
  assert.deepEqual(validateRefundBinding(binding), binding)
  assert.equal(validateRefundSourceReceipt(source('refund', 'request-1', '2026-09-26T01:00:00Z'), binding, 'before').operation, 'refund')
  assert.equal(validateRefundSourceReceipt(source('refund_query', 'request-2', '2026-09-26T01:10:00Z'), binding, 'after').operation, 'refund_query')
  assert.throws(() => validateRefundBinding({ ...binding, reservation_key: 'recharge-refund:other-order:1' }))
  assert.throws(() => validateRefundSourceReceipt({ ...source('refund', 'request-1', '2026-09-26T01:00:00Z'), source: 'fixture' }, binding, 'before'))
  assert.throws(() => validateRefundSourceReceipt({ ...source('refund', 'request-1', '2026-09-26T01:00:00Z'), refund_request_id_sha256: hash('other') }, binding, 'before'))
  assert.throws(() => validateRefundSourceReceipt({ ...source('refund_query', 'request-2', '2026-09-26T01:10:00Z'), provider_native_status: 'PROCESSING' }, binding, 'after'))
  assert.throws(() => validateRefundSourceReceipt({ ...source('refund_query', 'request-2', '2026-09-26T01:10:00Z'), signed_response_sha256: undefined }, binding, 'after'))
})

test('refund pair requires same wallet reservation and paid to closed transition', () => {
  const before = snapshot('before', 'request-1', '2026-09-26T01:00:00Z', '2026-09-26T01:01:00Z')
  const after = snapshot('after', 'request-2', '2026-09-26T01:10:00Z', '2026-09-26T01:11:00Z')
  assert.equal(validateRefundSnapshotPair(before, after, binding), true)
  for (const changed of [
    { reservation_transaction_sha256: hash('other-reservation') }, { recharge_transaction_sha256: hash('other-credit') },
    { release_count: 1 }, { order_state: 'paid' }, { source_request_id: 'request-1' },
    { source_observed_at: '2026-09-26T01:00:30Z' }, { source_observed_at: '2026-09-26T01:12:00Z' },
    { workspace_id_sha256: hash('other-workspace') }, { refund_request_id_sha256: hash('other-refund') },
    { release_binding_verified: true }, { source_receipt_sha256: 'missing' },
  ]) assert.throws(() => validateRefundSnapshotPair(before, { ...after, ...changed }, binding))
})

const guard = { role_name: 'payment_evidence_reader', read_only: 'on', row_security: 'on', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, role_membership: false, can_mutate: false, forced_rls: true }
function clientFor(phase, override = {}) {
  const calls = []
  const order = { id: binding.order_id, workspace_id: binding.workspace_id, state: phase === 'before' ? 'paid' : 'closed', payment_mode: 'provider', channel: 'alipay', amount_fen: '100', provider_trade_id: binding.provider_trade_id }
  const rows = { order: [order], recharge: [{ id: 'recharge-row', workspace_id: binding.workspace_id, order_id: binding.order_id, type: 'recharge', amount_fen: '100' }], reservation: [{ id: 'reservation-row', workspace_id: binding.workspace_id, order_id: binding.reservation_key, type: 'debit', amount_fen: '100' }], release: [], ...override }
  return { calls, query: async (sql, params) => {
    calls.push({ sql, params })
    if (sql.startsWith('SELECT current_user')) return { rows: [override.guard ?? guard] }
    if (sql.includes('FROM billing_orders WHERE')) return { rows: rows.order }
    if (sql.includes("type='recharge'")) return { rows: rows.recharge }
    if (sql.includes("type='debit'")) return { rows: rows.reservation }
    if (sql.includes("type='refund'")) return { rows: rows.release }
    return { rows: [] }
  } }
}

test('read-only RLS role captures bounded before and after facts', async () => {
  for (const phase of ['before', 'after']) {
    const client = clientFor(phase)
    const captured = await readRefundLedgerSnapshot(client, binding, phase)
    assert.equal(captured.order_state, phase === 'before' ? 'paid' : 'closed')
    assert.equal(captured.reservation_transaction_sha256, hash('reservation-row'))
    assert.deepEqual(client.calls.find(item => item.sql.includes("set_config('app.workspace_id'"))?.params, [binding.workspace_id])
    assert.equal(client.calls.at(-1).sql, 'COMMIT')
    assert.equal(client.calls.every(item => !/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:INTO\s+)?(?:billing_orders|billing_transactions)\b/iu.test(item.sql)), true)
  }
})

test('snapshot rejects writer role, mismatched money and released reservation', async () => {
  const writer = clientFor('before', { guard: { ...guard, role_name: 'merchant_ops', can_mutate: true } })
  await assert.rejects(readRefundLedgerSnapshot(writer, binding, 'before'), /dedicated read-only RLS/)
  assert.equal(writer.calls.at(-1).sql, 'ROLLBACK')
  assert.equal(writer.calls.some(item => item.sql.includes('FROM billing_orders WHERE')), false)
  for (const change of [
    { order: [{ id: binding.order_id, workspace_id: binding.workspace_id, state: 'paid', payment_mode: 'fixture', channel: 'alipay', amount_fen: '100', provider_trade_id: binding.provider_trade_id }] },
    { reservation: [{ id: 'reservation-row', workspace_id: binding.workspace_id, order_id: binding.reservation_key, type: 'debit', amount_fen: '101' }] },
    { release: [{ id: 'released-row' }] },
  ]) {
    const client = clientFor('before', change)
    await assert.rejects(readRefundLedgerSnapshot(client, binding, 'before'))
    assert.equal(client.calls.at(-1).sql, 'ROLLBACK')
  }
})
