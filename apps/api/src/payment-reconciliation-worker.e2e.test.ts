import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac, randomUUID } from 'node:crypto'
import { enableCommercialFixtureHarnessForTests, operationAudits, server, setPaymentProviderForTests } from './server.js'
import { createWorkerRequestProof, type WorkerRequestRole } from '../../../packages/security/src/worker-request-proof.js'
import type { PaymentProvider, PaymentRefundStatusResult } from '../../../packages/billing/src/payment-provider.js'

type Envelope = { workspace_id: string; data: Record<string, any> | null; error: { code: string; message: string; details?: Record<string, unknown> } | null }

const path = '/v1/internal/billing/reconciliation'
const workerId = 'payment-reconcile-http-test'
const credentials = {
  reconcile: { token: 'payment-reconcile-test-token', signing_secret: 'payment-reconcile-test-secret' },
  generation: { token: 'payment-generation-test-token', signing_secret: 'payment-generation-test-secret' },
}

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function signedRequest(workspaceId: string, payload: Record<string, unknown>, role: WorkerRequestRole = 'reconcile') {
  const credential = credentials[role as keyof typeof credentials]
  const body = JSON.stringify(payload)
  const proof = createWorkerRequestProof({ secret: credential.signing_secret, workerId, role, method: 'POST', requestTarget: path, workspaceId, body })
  return { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: `Bearer ${credential.token}`, 'x-workspace-id': workspaceId, ...proof.headers } }
}

async function reconcile(base: string, workspaceId: string, payload: Record<string, unknown> = { workspace_id: workspaceId }) {
  const response = await fetch(`${base}${path}`, signedRequest(workspaceId, payload))
  return { status: response.status, envelope: await response.json() as Envelope }
}

async function workerAudits(workspaceId: string) {
  return (await operationAudits.list(workspaceId, 100)).filter(item => item.action === 'billing.reconciliation.worker')
}

function configureProvider(provider: PaymentProvider) {
  // Every payment operation is the injected deterministic adapter, never a
  // network request. These .example values exercise readiness validation only.
  for (const [key, value] of Object.entries({
    PAYMENT_MODE: 'provider', PAYMENT_PROVIDER_ADAPTERS: 'alipay,wechat',
    PAYMENT_CHECKOUT_BASE_URL: 'https://payments.example/checkout',
    PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://payments.example/api/checkout',
    PAYMENT_PROVIDER_QUERY_API_URL: 'https://payments.example/api/query',
    PAYMENT_PROVIDER_REFUND_API_URL: 'https://payments.example/api/refund',
    PAYMENT_PROVIDER_REFUND_QUERY_API_URL: 'https://payments.example/api/refund/query',
    PAYMENT_PROVIDER_API_KEY: 'test-provider-key', PAYMENT_PROVIDER_MERCHANT_ID: 'merchant-test',
    PAYMENT_CALLBACK_BASE_URL: 'https://merchant.example/v1', PAYMENT_CALLBACK_SECRET: 'callback-secret',
    PAYMENT_REFUND_ENABLED: 'true',
  })) vi.stubEnv(key, value)
  setPaymentProviderForTests(provider)
}

async function fixtureMcp(base: string, workspaceId: string, method: string, params: Record<string, unknown> = {}) {
  // Seed and inspect the memory wallet through the existing explicit test-only
  // merchant harness. Each worker request still executes with staging auth.
  enableCommercialFixtureHarnessForTests()
  const previous = process.env.NODE_ENV
  vi.stubEnv('NODE_ENV', 'test')
  try {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'finance-test', 'x-test-commercial-fixture': 'server-e2e' },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { ...params, workspace_id: workspaceId } }),
    })
    return await response.json() as Envelope
  } finally { vi.stubEnv('NODE_ENV', previous) }
}

async function createRecharge(base: string, workspaceId: string) {
  const result = await fixtureMcp(base, workspaceId, 'billing.recharge.create', { channel: 'alipay', amount_cny: '10.00', idempotency_key: randomUUID() })
  expect(result.error).toBeNull()
  expect(result.data?.result).toMatchObject({ id: expect.any(String), state: 'pending' })
  return result.data!.result.id as string
}

async function paidRecharge(base: string, workspaceId: string) {
  const orderId = await createRecharge(base, workspaceId)
  const providerTradeId = `trade-${orderId}`
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = `nonce-${randomUUID()}`
  const canonical = `alipay|${workspaceId}|${orderId}|${providerTradeId}|1000|CNY|paid|${timestamp}|${nonce}`
  const signature = createHmac('sha256', 'callback-secret').update(canonical).digest('hex')
  const response = await fetch(`${base}/v1/billing/callback/alipay`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-payment-timestamp': timestamp, 'x-payment-nonce': nonce, 'x-payment-signature': signature },
    body: JSON.stringify({ workspace_id: workspaceId, order_id: orderId, provider_trade_id: providerTradeId, amount_fen: 1000, currency: 'CNY', state: 'paid' }),
  })
  expect(response.status).toBe(200)
  expect((await response.json() as Envelope).data).toMatchObject({ accepted: true, order_id: orderId, state: 'paid' })
  return orderId
}

async function wallet(base: string, workspaceId: string) {
  const response = await fixtureMcp(base, workspaceId, 'billing.transactions', { scope: 'workspace', limit: '100' })
  expect(response.error).toBeNull()
  return response.data!.result as { balance_cny: string; transactions: Array<{ id: string; type: string; orderId?: string }> }
}

const queryStatus = vi.fn(async () => ({ state: 'pending' as const }))

beforeEach(() => {
  // Staging deliberately exercises signed role-proof auth. The safe test
  // launcher excludes shared credentials, databases and provider configuration.
  vi.stubEnv('NODE_ENV', 'staging')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'payment-reconcile-session-hash-test')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'true')
  vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify(credentials))
  queryStatus.mockClear()
  setPaymentProviderForTests({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/unused' }), queryStatus, refund: async () => ({ providerRefundId: 'unused' }) })
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setPaymentProviderForTests(undefined)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('payment reconciliation signed worker HTTP boundary', () => {
  it.each(['unsigned', 'generation role', 'missing workspace header', 'tampered body', 'cross-workspace proof', 'forged worker identity'])(
    'rejects %s without querying a provider or writing a completion audit', async variant => {
      const workspaceId = `ws_payment_proof_${randomUUID()}`
      const request = signedRequest(workspaceId, { workspace_id: workspaceId, limit: 10 }, variant === 'generation role' ? 'generation' : 'reconcile')
      const headers: Record<string, string> = { ...request.headers }
      if (variant === 'unsigned') {
        for (const key of Object.keys(headers)) if (key.startsWith('x-worker-')) delete headers[key]
      }
      if (variant === 'missing workspace header') delete headers['x-workspace-id']
      if (variant === 'cross-workspace proof') headers['x-workspace-id'] = `${workspaceId}_other`
      if (variant === 'forged worker identity') headers['x-worker-id'] = 'forged-worker'
      const base = await start()
      const response = await fetch(`${base}${path}`, { ...request, headers, body: variant === 'tampered body' ? `${request.body} ` : request.body })
      expect(response.status).toBe(403)
      expect((await response.json() as Envelope).error?.code).toBe('FORBIDDEN')
      expect(queryStatus).not.toHaveBeenCalled()
      expect(await workerAudits(workspaceId)).toEqual([])
    },
  )

  it('rejects a valid signature when the body selects a different workspace', async () => {
    const workspaceId = `ws_payment_scope_${randomUUID()}`
    const base = await start()
    const result = await reconcile(base, workspaceId, { workspace_id: `${workspaceId}_other`, limit: 10 })
    expect(result.status).toBe(403)
    expect(result.envelope.error?.code).toBe('TENANT_SCOPE_DENIED')
    expect(queryStatus).not.toHaveBeenCalled()
    expect(await workerAudits(workspaceId)).toEqual([])
    expect(await workerAudits(`${workspaceId}_other`)).toEqual([])
  })

  it.each([undefined, null, '', '   ', 42])('requires a non-empty string body workspace_id (%s)', async workspace => {
    const workspaceId = `ws_payment_body_${randomUUID()}`
    const base = await start()
    const result = await reconcile(base, workspaceId, { workspace_id: workspace, limit: 10 })
    expect(result.status).toBe(400)
    expect(result.envelope.error?.code).toBe('INVALID_REQUEST')
    expect(queryStatus).not.toHaveBeenCalled()
    expect(await workerAudits(workspaceId)).toEqual([])
  })

  it.each([0, -1, 21, 1.5, null, true, [1], {}, '', '  ', '20', '1e1', '0x10'])(
    'rejects invalid or coercible query budgets (%j)', async limit => {
      const workspaceId = `ws_payment_limit_${randomUUID()}`
      const base = await start()
      const result = await reconcile(base, workspaceId, { workspace_id: workspaceId, limit })
      expect(result.status).toBe(400)
      expect(result.envelope.error?.code).toBe('INVALID_REQUEST')
      expect(queryStatus).not.toHaveBeenCalled()
      expect(await workerAudits(workspaceId)).toEqual([])
    },
  )

  it.each([undefined, 1, 20])('uses a bounded query budget and audits the verified worker (%s)', async limit => {
    const workspaceId = `ws_payment_budget_${randomUUID()}`
    const base = await start()
    const result = await reconcile(base, workspaceId, { workspace_id: workspaceId, limit })
    const expectedLimit = limit === undefined ? 10 : Number(limit)
    expect(result.status).toBe(200)
    expect(result.envelope.error).toBeNull()
    expect(result.envelope.data).toMatchObject({ state: 'completed', checked: 0, payment_checked: 0, refund_checked: 0, total_query_budget: expectedLimit, settled: [], pending: [], failed: [], refund_settled: [], refund_pending: [], refund_failed: [] })
    expect(await workerAudits(workspaceId)).toEqual([expect.objectContaining({
      actorId: `worker:${workerId}`, resourceType: 'billing_reconciliation', resourceId: workspaceId,
      after: { state: 'completed', limit: expectedLimit, checked: 0, payment_checked: 0, refund_checked: 0, settled: 0, pending: 0, failed: 0, refund_settled: 0, refund_pending: 0, refund_failed: 0 },
    })])
    expect(queryStatus).not.toHaveBeenCalled()
  })

  it('does not record a second completion for a replayed signed request', async () => {
    const workspaceId = `ws_payment_replay_${randomUUID()}`
    const base = await start()
    const request = signedRequest(workspaceId, { workspace_id: workspaceId })
    const first = await fetch(`${base}${path}`, request)
    expect(first.status).toBe(200)
    expect((await first.json() as Envelope).error).toBeNull()
    const second = await fetch(`${base}${path}`, request)
    expect(second.status).toBe(409)
    expect((await second.json() as Envelope).error?.code).toBe('WORKER_NONCE_REPLAY')
    expect(await workerAudits(workspaceId)).toHaveLength(1)
  })

  it('fails closed while automatic payment reconciliation is disabled', async () => {
    vi.stubEnv('PAYMENT_RECONCILIATION_ENABLED', 'false')
    const workspaceId = `ws_payment_disabled_${randomUUID()}`
    const base = await start()
    const result = await reconcile(base, workspaceId)
    expect(result.status).toBe(503)
    expect(result.envelope.error?.code).toBe('PAYMENT_RECONCILIATION_DISABLED')
    expect(queryStatus).not.toHaveBeenCalled()
    expect(await workerAudits(workspaceId)).toEqual([])
  })

  it('reports missing provider query capability explicitly instead of a completed reconciliation', async () => {
    setPaymentProviderForTests({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/unused' }), refund: async () => ({ providerRefundId: 'unused' }) })
    const workspaceId = `ws_payment_unconfigured_${randomUUID()}`
    const base = await start()
    const result = await reconcile(base, workspaceId)
    expect(result.status).toBe(200)
    expect(result.envelope.error).toBeNull()
    expect(result.envelope.data).toMatchObject({ state: 'not_configured', checked: 0, settled: [], pending: [], failed: [] })
    expect(await workerAudits(workspaceId)).toEqual([expect.objectContaining({ after: expect.objectContaining({ state: 'not_configured', checked: 0 }) })])
  })

  it('fails closed in production when the provider query capability is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    setPaymentProviderForTests({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/unused' }), refund: async () => ({ providerRefundId: 'unused' }) })
    const workspaceId = `ws_payment_prod_${randomUUID()}`
    const base = await start()
    const result = await reconcile(base, workspaceId)
    expect(result.status).toBe(503)
    expect(result.envelope.error?.code).toBe('PAYMENT_RECONCILIATION_UNAVAILABLE')
    expect(await workerAudits(workspaceId)).toEqual([expect.objectContaining({ actorId: `worker:${workerId}`, after: { state: 'failed', limit: 10, code: 'PAYMENT_RECONCILIATION_UNAVAILABLE' } })])
  })

  it('settles only the signed tenant within the budget and never credits an order twice', async () => {
    const providerQuery = vi.fn<NonNullable<PaymentProvider['queryStatus']>>(async input => ({ state: 'paid', providerTradeId: `trade-${input.orderId}`, amountFen: 1000 }))
    configureProvider({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay' }), queryStatus: providerQuery, refund: async () => ({ providerRefundId: 'unused' }) })
    const base = await start()
    const workspaceId = `ws_payment_settle_${randomUUID()}`
    const otherWorkspace = `ws_payment_other_${randomUUID()}`
    const orderIds = [await createRecharge(base, workspaceId), await createRecharge(base, workspaceId)]
    await createRecharge(base, otherWorkspace)

    const first = await reconcile(base, workspaceId, { workspace_id: workspaceId, limit: 1 })
    expect(first.status).toBe(200)
    expect(first.envelope.data).toMatchObject({ state: 'completed', checked: 1, payment_checked: 1, refund_checked: 0, total_query_budget: 1, settled: [expect.objectContaining({ order_id: expect.any(String) })] })
    expect(providerQuery).toHaveBeenCalledOnce()
    expect(providerQuery).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, orderId: expect.stringMatching(/^recharge_/u) }))
    expect((await wallet(base, workspaceId)).balance_cny).toBe('10.00')
    expect((await wallet(base, otherWorkspace)).balance_cny).toBe('0.00')

    const second = await reconcile(base, workspaceId)
    expect(second.envelope.data).toMatchObject({ checked: 1, payment_checked: 1 })
    const third = await reconcile(base, workspaceId)
    expect(third.envelope.data).toMatchObject({ checked: 0, settled: [], idempotent_settlement: true })
    expect(providerQuery).toHaveBeenCalledTimes(2)
    expect(providerQuery.mock.calls.map(([input]) => input.orderId).sort()).toEqual([...orderIds].sort())
    const finalWallet = await wallet(base, workspaceId)
    expect(finalWallet.balance_cny).toBe('20.00')
    expect(finalWallet.transactions.filter(item => item.type === 'recharge')).toHaveLength(2)
    expect(await workerAudits(workspaceId)).toHaveLength(3)
    expect(await workerAudits(otherWorkspace)).toEqual([])
  })

  it.each(['processing', 'transport error'])('holds a refund after %s until reconciliation proves success, without a second debit', async initialOutcome => {
    const providerRefund = vi.fn<PaymentProvider['refund']>(async () => {
      if (initialOutcome === 'transport error') throw new Error('deterministic provider transport failure')
      return { providerRefundId: 'refund-in-flight', state: 'processing' }
    })
    const refundQuery = vi.fn<NonNullable<PaymentProvider['queryRefundStatus']>>(async () => ({ state: 'succeeded', providerRefundId: 'refund-confirmed', amountFen: 1000 }))
    configureProvider({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay' }), queryStatus, refund: providerRefund, queryRefundStatus: refundQuery })
    const base = await start()
    const workspaceId = `ws_refund_success_${randomUUID()}`
    const orderId = await paidRecharge(base, workspaceId)
    const refund = await fixtureMcp(base, workspaceId, 'billing.refund', { order_id: orderId, reason: 'unknown refund result test' })
    expect(refund.error).toMatchObject({ code: 'PAYMENT_PROVIDER_REFUND_OUTCOME_UNKNOWN', details: { reservation_released: false } })
    const held = await wallet(base, workspaceId)
    const reservation = held.transactions.find(item => item.type === 'debit' && item.orderId?.startsWith(`recharge-refund:${orderId}:`))
    expect(reservation).toBeDefined()
    expect(held.balance_cny).toBe('0.00')
    expect(held.transactions.filter(item => item.type === 'refund')).toEqual([])
    expect(providerRefund).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, orderId, refundRequestId: reservation!.id }))

    const result = await reconcile(base, workspaceId)
    expect(result.status).toBe(200)
    expect(result.envelope.data).toMatchObject({ state: 'completed', checked: 1, payment_checked: 0, refund_checked: 1, refund_settled: [{ order_id: orderId, refund_request_id: reservation!.id }], refund_pending: [], refund_failed: [] })
    expect(refundQuery).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, orderId, refundRequestId: reservation!.id, amountFen: 1000 }))
    expect(queryStatus).not.toHaveBeenCalled()
    const replay = await reconcile(base, workspaceId)
    expect(replay.envelope.data).toMatchObject({ state: 'completed', checked: 0, refund_checked: 0, refund_settled: [] })
    const retry = await fixtureMcp(base, workspaceId, 'billing.refund', { order_id: orderId, reason: 'retry confirmed refund' })
    expect(retry.error).toBeNull()
    expect(retry.data?.result).toMatchObject({ replayed: true })
    expect(providerRefund).toHaveBeenCalledOnce()
    expect(refundQuery).toHaveBeenCalledOnce()
    expect((await wallet(base, workspaceId)).transactions).toEqual(held.transactions)
    expect(await workerAudits(workspaceId)).toEqual(expect.arrayContaining([expect.objectContaining({ after: expect.objectContaining({ refund_checked: 1, refund_settled: 1, refund_failed: 0 }) })]))
  })

  it('releases a held refund exactly once only after the provider confirms failure', async () => {
    const refundQuery = vi.fn<NonNullable<PaymentProvider['queryRefundStatus']>>(async () => ({ state: 'failed', providerRefundId: 'refund-failed', amountFen: 1000 }))
    configureProvider({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay' }), queryStatus, refund: async () => ({ providerRefundId: 'refund-in-flight', state: 'processing' }), queryRefundStatus: refundQuery })
    const base = await start()
    const workspaceId = `ws_refund_failed_${randomUUID()}`
    const orderId = await paidRecharge(base, workspaceId)
    const refund = await fixtureMcp(base, workspaceId, 'billing.refund', { order_id: orderId, reason: 'pending refund later fails' })
    expect(refund.error?.code).toBe('PAYMENT_PROVIDER_REFUND_OUTCOME_UNKNOWN')
    expect((await wallet(base, workspaceId)).balance_cny).toBe('0.00')
    const result = await reconcile(base, workspaceId)
    expect(result.status).toBe(200)
    expect(result.envelope.data).toMatchObject({ state: 'attention_required', checked: 1, refund_checked: 1, refund_failed: [expect.objectContaining({ order_id: orderId, code: 'PAYMENT_PROVIDER_REFUND_FAILED', reservation_released: true })] })
    const released = await wallet(base, workspaceId)
    expect(released.balance_cny).toBe('10.00')
    expect(released.transactions.filter(item => item.type === 'refund' && item.orderId?.startsWith('release:recharge-refund:'))).toHaveLength(1)
    expect((await reconcile(base, workspaceId)).envelope.data).toMatchObject({ checked: 0, refund_checked: 0, refund_failed: [] })
    expect((await wallet(base, workspaceId)).transactions).toEqual(released.transactions)
    expect(refundQuery).toHaveBeenCalledOnce()
    expect(await workerAudits(workspaceId)).toEqual(expect.arrayContaining([expect.objectContaining({ after: expect.objectContaining({ state: 'attention_required', refund_failed: 1, refund_settled: 0 }) })]))
  })

  it.each([
    { state: 'pending' }, { state: 'unknown' },
    { state: 'succeeded', providerRefundId: 'refund-unverified', amountFen: 999 },
    { state: 'succeeded', amountFen: 1000 },
  ] satisfies PaymentRefundStatusResult[])('retains the reservation without complete refund evidence (%j)', async refundStatus => {
    configureProvider({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay' }), queryStatus, refund: async () => ({ providerRefundId: 'refund-in-flight', state: 'processing' }), queryRefundStatus: async () => refundStatus })
    const base = await start()
    const workspaceId = `ws_refund_hold_${randomUUID()}`
    const orderId = await paidRecharge(base, workspaceId)
    expect((await fixtureMcp(base, workspaceId, 'billing.refund', { order_id: orderId, reason: 'refund evidence is incomplete' })).error?.code).toBe('PAYMENT_PROVIDER_REFUND_OUTCOME_UNKNOWN')
    const held = await wallet(base, workspaceId)
    const result = await reconcile(base, workspaceId)
    expect(result.status).toBe(200)
    expect(result.envelope.data).toMatchObject({ state: 'attention_required', refund_checked: 1, refund_settled: [] })
    expect((await wallet(base, workspaceId)).balance_cny).toBe('0.00')
    expect((await wallet(base, workspaceId)).transactions).toEqual(held.transactions)
  })

  it('shares one query budget between pending payments and held refunds', async () => {
    const refundQuery = vi.fn<NonNullable<PaymentProvider['queryRefundStatus']>>(async () => ({ state: 'pending' }))
    configureProvider({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay' }), queryStatus, refund: async () => ({ providerRefundId: 'refund-in-flight', state: 'processing' }), queryRefundStatus: refundQuery })
    const base = await start()
    const workspaceId = `ws_payment_mixed_${randomUUID()}`
    const orderId = await paidRecharge(base, workspaceId)
    expect((await fixtureMcp(base, workspaceId, 'billing.refund', { order_id: orderId, reason: 'mixed reconciliation budget' })).error?.code).toBe('PAYMENT_PROVIDER_REFUND_OUTCOME_UNKNOWN')
    await createRecharge(base, workspaceId)
    const result = await reconcile(base, workspaceId, { workspace_id: workspaceId, limit: 1 })
    expect(result.status).toBe(200)
    expect(result.envelope.data).toMatchObject({ checked: 1, total_query_budget: 1 })
    expect(Number(result.envelope.data?.payment_checked) + Number(result.envelope.data?.refund_checked)).toBe(1)
    expect(queryStatus.mock.calls.length + refundQuery.mock.calls.length).toBe(1)
    expect((await wallet(base, workspaceId)).balance_cny).toBe('0.00')
  })

  it('queries held refunds in every round despite continuously pending slow payments', async () => {
    let currentTime = Date.now()
    const calls: Array<{ kind: 'payment' | 'refund'; orderId: string }> = []
    const providerQuery = vi.fn<NonNullable<PaymentProvider['queryStatus']>>(async input => {
      calls.push({ kind: 'payment', orderId: input.orderId })
      currentTime += 60_000
      return { state: 'pending' }
    })
    const refundQuery = vi.fn<NonNullable<PaymentProvider['queryRefundStatus']>>(async input => {
      calls.push({ kind: 'refund', orderId: input.orderId })
      currentTime += 60_000
      return { state: 'pending' }
    })
    configureProvider({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay' }), queryStatus: providerQuery, refund: async () => ({ providerRefundId: 'refund-in-flight', state: 'processing' }), queryRefundStatus: refundQuery })
    const base = await start()
    const workspaceId = `ws_refund_fairness_${randomUUID()}`
    const heldOrderIds: string[] = []
    for (let index = 0; index < 2; index += 1) {
      const orderId = await paidRecharge(base, workspaceId)
      heldOrderIds.push(orderId)
      expect((await fixtureMcp(base, workspaceId, 'billing.refund', { order_id: orderId, reason: 'held refund must not starve' })).error?.code).toBe('PAYMENT_PROVIDER_REFUND_OUTCOME_UNKNOWN')
    }
    for (let index = 0; index < 5; index += 1) await createRecharge(base, workspaceId)
    const heldWallet = await wallet(base, workspaceId)
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime)
    const rounds: Array<{ result: Awaited<ReturnType<typeof reconcile>>; calls: typeof calls }> = []
    for (let round = 0; round < 2; round += 1) {
      const from = calls.length
      const result = await reconcile(base, workspaceId, { workspace_id: workspaceId, limit: 10 })
      rounds.push({ result, calls: calls.slice(from) })
    }
    for (const round of rounds) {
      expect(round.result.status).toBe(200)
      expect(round.result.envelope.data).toMatchObject({ state: 'attention_required', checked: 3, payment_checked: 1, refund_checked: 2, deferred: 4, total_query_budget: 10 })
      expect(round.calls.map(call => call.kind)).toEqual(['refund', 'payment', 'refund'])
      expect(round.calls.filter(call => call.kind === 'refund').map(call => call.orderId).sort()).toEqual([...heldOrderIds].sort())
    }
    expect((await wallet(base, workspaceId)).transactions).toEqual(heldWallet.transactions)
    expect((await wallet(base, workspaceId)).balance_cny).toBe('0.00')
  })

  it('audits the paid state before a successful direct refund mutates the memory order', async () => {
    const providerRefund = vi.fn<PaymentProvider['refund']>(async () => ({ providerRefundId: 'refund-confirmed', state: 'succeeded' }))
    configureProvider({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay' }), queryStatus, refund: providerRefund })
    const base = await start()
    const workspaceId = `ws_refund_audit_${randomUUID()}`
    const orderId = await paidRecharge(base, workspaceId)
    const result = await fixtureMcp(base, workspaceId, 'billing.refund', { order_id: orderId, reason: 'successful refund audit snapshot' })
    expect(result.error).toBeNull()
    const audits = (await operationAudits.list(workspaceId, 100)).filter(item => item.action === 'billing.refund' && item.resourceId === orderId)
    expect(audits).toEqual([expect.objectContaining({ actorId: 'finance-test', before: expect.objectContaining({ state: 'paid' }), after: expect.objectContaining({ providerRefundId: 'refund-confirmed' }) })])
    expect((await wallet(base, workspaceId)).balance_cny).toBe('0.00')
    expect(providerRefund).toHaveBeenCalledOnce()
  })

  it('defers remaining orders after the query deadline and resumes them in a new pass', async () => {
    let currentTime = Date.now()
    const providerQuery = vi.fn<NonNullable<PaymentProvider['queryStatus']>>(async input => {
      currentTime += 3 * 60_000
      return { state: 'paid', providerTradeId: `trade-${input.orderId}`, amountFen: 1000 }
    })
    configureProvider({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay' }), queryStatus: providerQuery, refund: async () => ({ providerRefundId: 'unused' }) })
    const base = await start()
    const workspaceId = `ws_payment_deadline_${randomUUID()}`
    await createRecharge(base, workspaceId)
    await createRecharge(base, workspaceId)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => currentTime)
    const first = await reconcile(base, workspaceId)
    expect(first.status).toBe(200)
    expect(first.envelope.data).toMatchObject({ state: 'attention_required', checked: 1, payment_checked: 1, deferred: 1, settled: [expect.any(Object)], pending: [], failed: [] })
    expect(providerQuery).toHaveBeenCalledOnce()
    expect((await wallet(base, workspaceId)).balance_cny).toBe('10.00')
    clock.mockRestore()
    const resumed = await reconcile(base, workspaceId)
    expect(resumed.status).toBe(200)
    expect(resumed.envelope.data).toMatchObject({ state: 'completed', checked: 1, deferred: 0 })
    expect(providerQuery).toHaveBeenCalledTimes(2)
    expect((await wallet(base, workspaceId)).balance_cny).toBe('20.00')
  })

  it('caps the desktop MCP string limit of 50 at twenty actual provider queries', async () => {
    const providerQuery = vi.fn<NonNullable<PaymentProvider['queryStatus']>>(async input => ({ state: 'paid', providerTradeId: `trade-${input.orderId}`, amountFen: 1000 }))
    configureProvider({ createCheckout: async () => ({ paymentUrl: 'https://payments.example/pay' }), queryStatus: providerQuery, refund: async () => ({ providerRefundId: 'unused' }) })
    const base = await start()
    const workspaceId = `ws_payment_mcp_cap_${randomUUID()}`
    for (let index = 0; index < 21; index += 1) await createRecharge(base, workspaceId)
    const first = await fixtureMcp(base, workspaceId, 'billing.reconciliation.run', { limit: '50' })
    expect(first.error).toBeNull()
    expect(first.data?.result).toMatchObject({ checked: 20, total_query_budget: 20 })
    expect(providerQuery).toHaveBeenCalledTimes(20)
    expect((await wallet(base, workspaceId)).balance_cny).toBe('200.00')
    const remainder = await reconcile(base, workspaceId)
    expect(remainder.status).toBe(200)
    expect(remainder.envelope.data).toMatchObject({ checked: 1, total_query_budget: 10 })
    expect(providerQuery).toHaveBeenCalledTimes(21)
    expect((await wallet(base, workspaceId)).balance_cny).toBe('210.00')
  })
})
