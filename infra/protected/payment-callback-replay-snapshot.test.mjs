import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { readScopedSnapshot, validateBinding, validateNativeReceipt, validateReplayPair } from './payment-callback-replay-snapshot.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const binding = { release_id: 'release-20260923', deployment_nonce: 'abcdefghijklmnopqrstuv', order_id: 'order-123', workspace_id: 'ws-test', provider_trade_id: 'trade-123', amount_fen: 100 }
const receipt = (requestId, observedAt) => ({ schema_version: 'payment-gateway-source-receipt.v1', source: 'alipay_native_notify', provider_signature_verified: true, api_callback_status: 200, callback_path: '/v1/billing/callback/alipay', state: 'paid', raw_body_stored: false, final_evidence: false, request_id: requestId, observed_at: observedAt, native_signature_sha256: hash('original-signature'), native_signed_fields_sha256: hash('original-native-fields'), order_id_sha256: hash(binding.order_id), workspace_id_sha256: hash(binding.workspace_id), provider_trade_id_sha256: hash(binding.provider_trade_id), amount_fen: 100 })
const snapshot = (requestId, nativeAt, observedAt) => ({ release_id: binding.release_id, deployment_nonce: binding.deployment_nonce, order_id_sha256: hash(binding.order_id), workspace_id_sha256: hash(binding.workspace_id), provider_trade_id_sha256: hash(binding.provider_trade_id), amount_fen: 100, native_request_id: requestId, native_observed_at: nativeAt, native_signature_sha256: hash('original-signature'), native_signed_fields_sha256: hash('original-native-fields'), observed_at: observedAt, transaction_count: 1, transaction_id_sha256: hash('ledger-row-1'), transaction_amount_fen: 100, order_state: 'paid', order_payment_mode: 'provider' })

test('fixed binding and verified native callback are required', () => {
  assert.deepEqual(validateBinding(binding), binding)
  assert.deepEqual(validateNativeReceipt(receipt('request-1', '2026-09-23T00:00:00Z'), binding).request_id, 'request-1')
  assert.throws(() => validateBinding({ ...binding, deployment_nonce: 'short' }))
  assert.throws(() => validateNativeReceipt({ ...receipt('request-1', '2026-09-23T00:00:00Z'), native_signature_sha256: 'bad' }, binding))
  assert.throws(() => validateNativeReceipt({ ...receipt('request-1', '2026-09-23T00:00:00Z'), amount_fen: 101 }, binding))
})

test('replay requires same native signed content, distinct delivery and unchanged single ledger row', () => {
  const before = snapshot('request-1', '2026-09-23T00:00:00Z', '2026-09-23T00:00:01Z')
  const after = snapshot('request-2', '2026-09-23T00:00:02Z', '2026-09-23T00:00:03Z')
  assert.equal(validateReplayPair(before, after, binding), true)
  for (const changed of [
    { transaction_count: 2 }, { transaction_id_sha256: hash('second-ledger-row') },
    { transaction_amount_fen: 101 }, { native_signature_sha256: hash('other-signature') },
    { native_request_id: 'request-1' }, { release_id: 'other-release' },
    { native_observed_at: '2026-09-23T00:00:00Z' },
  ]) assert.throws(() => validateReplayPair(before, { ...after, ...changed }, binding))
})

test('read-only scoped DB snapshot rejects a writer role and rolls back', async () => {
  const commands = []
  const client = { query: async sql => { commands.push(sql); if (sql.startsWith('SELECT current_user')) return { rows: [{ role_name: 'merchant_ops', read_only: 'on', row_security: 'on', forced_rls: true, can_mutate: true }] }; return { rows: [] } } }
  await assert.rejects(readScopedSnapshot(client, binding), /dedicated read-only RLS/)
  assert.match(commands[0], /READ ONLY/)
  assert.equal(commands.at(-1), 'ROLLBACK')
  assert.equal(commands.some(command => command.includes('billing_orders WHERE')), false)
})

test('read-only scoped DB snapshot accepts one matching durable recharge row', async () => {
  const commands = []
  const guard = { role_name: 'payment_evidence_reader', read_only: 'on', row_security: 'on', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, role_membership: false, can_mutate: false, forced_rls: true }
  const client = { query: async (sql, params) => { commands.push({ sql, params }); if (sql.startsWith('SELECT current_user')) return { rows: [guard] }; if (sql.includes('FROM billing_orders WHERE')) return { rows: [{ id: binding.order_id, workspace_id: binding.workspace_id, state: 'paid', payment_mode: 'provider', channel: 'alipay', amount_fen: '100', provider_trade_id: binding.provider_trade_id }] }; if (sql.includes('FROM billing_transactions WHERE')) return { rows: [{ id: 'ledger-row-1', workspace_id: binding.workspace_id, order_id: binding.order_id, type: 'recharge', amount_fen: '100' }] }; return { rows: [] } } }
  const captured = await readScopedSnapshot(client, binding)
  assert.equal(captured.transaction_count, 1)
  assert.equal(captured.transaction_id_sha256, hash('ledger-row-1'))
  assert.deepEqual(commands.find(item => item.sql.includes("set_config('app.workspace_id'"))?.params, [binding.workspace_id])
  assert.equal(commands.at(-1).sql, 'COMMIT')
})
