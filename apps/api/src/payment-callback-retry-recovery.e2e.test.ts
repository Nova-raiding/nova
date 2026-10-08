import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { enableCommercialFixtureHarnessForTests, server, setPaymentCallbackNonceRepositoryForTests } from './server.js'
import { MemoryPaymentCallbackNonceRepository } from '../../../packages/persistence/src/payment-callback-repository.js'

type Envelope<T = any> = { data: T | null; error: { code: string; message: string } | null }

async function start() {
  enableCommercialFixtureHarnessForTests()
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
  vi.stubEnv('PAYMENT_CALLBACK_SECRET', 'callback-retry-test-secret')
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function json<T>(response: Response) { return await response.json() as Envelope<T> }

describe('signed payment callback retry recovery', () => {
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    setPaymentCallbackNonceRepositoryForTests()
    vi.unstubAllEnvs()
  })

  it('recovers the same signed proof after nonce consumption but failed order settlement, exactly once', async () => {
    const nonceRepository = new MemoryPaymentCallbackNonceRepository()
    setPaymentCallbackNonceRepositoryForTests(nonceRepository)
    const base = await start()
    const workspaceId = `ws_callback_retry_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const create = await fetch(`${base}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'billing.recharge.create', params: { workspace_id: workspaceId, channel: 'alipay', amount_cny: '10.00', idempotency_key: `retry-${workspaceId}` } }),
    }).then(response => json<{ result: { id: string; amount_cny: string } }>(response))
    expect(create.error).toBeNull()
    const order = create.data!.result
    const providerTradeId = `trade-${workspaceId}`
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = `callbackRetry${Date.now()}`
    const canonical = `alipay|${workspaceId}|${order.id}|${providerTradeId}|1000|CNY|paid|${timestamp}|${nonce}`
    const proof = {
      'content-type': 'application/json',
      'x-payment-timestamp': timestamp,
      'x-payment-nonce': nonce,
      'x-payment-signature': createHmac('sha256', 'callback-retry-test-secret').update(canonical).digest('hex'),
    }
    const nonceInput = {
      workspaceId, channel: 'alipay' as const, nonce,
      signedAt: new Date(Number(timestamp) * 1000).toISOString(),
      payloadHash: createHash('sha256').update(canonical).digest('hex'),
    }

    // The first delivery verified and recorded this nonce, then its order-row
    // transaction failed to acquire the lock. The retry is the identical proof.
    await expect(nonceRepository.consume(nonceInput)).resolves.toBe(true)
    const callbackBody = JSON.stringify({ workspace_id: workspaceId, order_id: order.id, provider_trade_id: providerTradeId, amount_fen: 1000, currency: 'CNY', state: 'paid' })
    const retry = await fetch(`${base}/v1/billing/callback/alipay`, { method: 'POST', headers: proof, body: callbackBody }).then(json<{ state: string }>)
    expect(retry.error).toBeNull()
    expect(retry.data).toMatchObject({ state: 'paid' })

    const replay = await fetch(`${base}/v1/billing/callback/alipay`, { method: 'POST', headers: proof, body: callbackBody }).then(json<{ state: string }>)
    expect(replay.error).toBeNull()
    const transactions = await fetch(`${base}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'billing.transactions', params: { workspace_id: workspaceId } }),
    }).then(response => json<{ result: { balance_cny: string; transactions: Array<{ type: string; orderId?: string }> } }>(response))
    expect(transactions.data?.result.balance_cny).toBe('10.00')
    expect(transactions.data?.result.transactions.filter(item => item.type === 'recharge' && item.orderId === order.id)).toHaveLength(1)

    const alteredCanonical = canonical.replace(providerTradeId, `${providerTradeId}-altered`)
    const conflictingProof = {
      ...proof,
      'x-payment-signature': createHmac('sha256', 'callback-retry-test-secret').update(alteredCanonical).digest('hex'),
    }
    const conflict = await fetch(`${base}/v1/billing/callback/alipay`, {
      method: 'POST', headers: conflictingProof,
      body: JSON.stringify({ workspace_id: workspaceId, order_id: order.id, provider_trade_id: `${providerTradeId}-altered`, amount_fen: 1000, currency: 'CNY', state: 'paid' }),
    }).then(json)
    expect(conflict.error?.code).toBe('PAYMENT_CALLBACK_NONCE_REPLAY')
  })
})
